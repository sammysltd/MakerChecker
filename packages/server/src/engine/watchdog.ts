import { isApprovalGate, type FlowDefinition } from "@makerchecker/shared";

import { recordEvent, type Actor } from "../audit/writer.js";
import { firePendingWebhooks, type PendingWebhook } from "../webhooks/dispatcher.js";
import { handleStepFailure, type EngineContext } from "./orchestrator.js";

const DEFAULT_GRACE_MS = 300_000;
const DEFAULT_STEP_TIMEOUT_MS = 60_000;
const DEFAULT_OVERDUE_MINUTES = 60;
const SYSTEM: Actor = { type: "system", id: "watchdog" };

/**
 * Recovers step attempts orphaned by a crashed worker: rows stuck in
 * 'running' past their step timeout plus a grace period get the standard
 * failure treatment (retry if attempts remain, else fail the run).
 * Wired to a periodic schedule at boot; tests invoke it directly.
 */
export async function sweepStuckSteps(
  ctx: EngineContext,
  options?: { graceMs?: number },
): Promise<number> {
  const graceMs = options?.graceMs ?? DEFAULT_GRACE_MS;
  const { rows: stuck } = await ctx.pool.query<{
    id: string;
    run_id: string;
    step_index: number;
    step_key: string;
    attempt: number;
    definition: FlowDefinition;
    elapsed_ms: string;
  }>(
    `SELECT sr.id, sr.run_id, sr.step_index, sr.step_key, sr.attempt, fv.definition,
            extract(epoch FROM (now() - sr.started_at)) * 1000 AS elapsed_ms
       FROM step_runs sr
       JOIN flow_runs fr ON fr.id = sr.run_id
       JOIN flow_versions fv ON fv.id = fr.flow_version_id
      WHERE sr.status = 'running'`,
  );

  let recovered = 0;
  for (const row of stuck) {
    const step = row.definition.steps[row.step_index];
    if (!step || isApprovalGate(step)) continue;
    const timeoutMs = step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS;
    if (Number(row.elapsed_ms) < timeoutMs + graceMs) continue;

    const pending: PendingWebhook[] = [];
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1::text))", [
        row.run_id,
      ]);
      // Re-check under the lock: the worker may have finished meanwhile.
      const still = await client.query(
        "SELECT 1 FROM step_runs WHERE id = $1 AND status = 'running'",
        [row.id],
      );
      if (still.rows.length > 0) {
        await handleStepFailure(
          client,
          {
            stepRunId: row.id,
            stepKey: row.step_key,
            attempt: row.attempt,
            runId: row.run_id,
            step,
            reason: "watchdog: step exceeded timeout with no worker progress (crashed worker?)",
            timedOut: true,
          },
          pending,
        );
        recovered += 1;
      }
      await client.query("COMMIT");
      firePendingWebhooks(ctx.pool, pending);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return recovered;
}

/**
 * The pending-too-long threshold, from MAKERCHECKER_APPROVAL_OVERDUE_MINUTES.
 * An unset or unparseable value falls back to 60 minutes — ambiguity never
 * silences the alarm.
 */
export function overdueThresholdMinutes(): number {
  const raw = process.env.MAKERCHECKER_APPROVAL_OVERDUE_MINUTES;
  if (raw === undefined || raw === "") return DEFAULT_OVERDUE_MINUTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OVERDUE_MINUTES;
}

/**
 * Flags approvals pending longer than the threshold: exactly ONE
 * approval.overdue audit event + webhook per approval, ever. The
 * notified_overdue_at claim (NULL -> now(), same transaction as the audit
 * event) is what makes the notification single-shot across concurrent
 * sweepers. Tests invoke it directly, like sweepStuckSteps.
 */
export async function sweepOverdueApprovals(
  ctx: EngineContext,
  options?: { overdueMinutes?: number },
): Promise<number> {
  const overdueMinutes = options?.overdueMinutes ?? overdueThresholdMinutes();
  const { rows: overdue } = await ctx.pool.query<{
    id: string;
    run_id: string;
    step_key: string;
    requested_at: Date;
    age_seconds: number;
  }>(
    `SELECT id, run_id, step_key, requested_at,
            extract(epoch FROM (now() - requested_at))::int AS age_seconds
       FROM approvals
      WHERE status = 'pending'
        AND notified_overdue_at IS NULL
        AND requested_at < now() - make_interval(mins => $1)`,
    [overdueMinutes],
  );

  let notified = 0;
  for (const row of overdue) {
    const pending: PendingWebhook[] = [];
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      // Claim the notification: only the transaction that flips NULL -> now()
      // gets to audit and notify.
      const claimed = await client.query(
        `UPDATE approvals SET notified_overdue_at = now()
          WHERE id = $1 AND status = 'pending' AND notified_overdue_at IS NULL
          RETURNING id`,
        [row.id],
      );
      if (claimed.rows.length > 0) {
        const payload = {
          stepKey: row.step_key,
          requestedAt: row.requested_at.toISOString(),
          ageSeconds: Number(row.age_seconds),
          thresholdMinutes: overdueMinutes,
        };
        await recordEvent(client, {
          eventType: "approval.overdue",
          actor: SYSTEM,
          entityType: "approval",
          entityId: row.id,
          runId: row.run_id,
          payload,
        });
        pending.push({
          event: "approval.overdue",
          runId: row.run_id,
          data: { approvalId: row.id, ...payload },
        });
        notified += 1;
      }
      await client.query("COMMIT");
      firePendingWebhooks(ctx.pool, pending);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return notified;
}
