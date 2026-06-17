import {
  gateEnforcesSeparation,
  isApprovalGate,
  type AgentStepDef,
  type ApprovalGateApprovalsDef,
  type FlowDefinition,
} from "@makerchecker/shared";
import type { Pool, PoolClient } from "pg";

import { recordEvent, type Actor } from "../audit/writer.js";
import { strictSod } from "../config.js";
import { redactValue, resolveRedactionHook } from "../llm/redaction.js";
import { firePendingWebhooks, type PendingWebhook } from "../webhooks/dispatcher.js";
import type { ExecutionBackend, TaskHandler } from "./backend.js";
import { enforce, EnforcementError } from "./enforcement.js";
import { loadDefinition } from "./flows.js";
import { getRoleLimits } from "./limits.js";
import type { Json, StepExecutionMeta, StepExecutor } from "./executor.js";

export const TASK_ADVANCE = "flow.advance";
export const TASK_EXECUTE_STEP = "step.execute";

const DEFAULT_STEP_TIMEOUT_MS = 60_000;
const SYSTEM: Actor = { type: "system", id: "engine" };

export interface EngineContext {
  pool: Pool;
  backend: ExecutionBackend;
  executor: StepExecutor;
}

interface RunRow {
  id: string;
  flow_version_id: string;
  status: string;
  input: Json;
}

interface StepRunRow {
  id: string;
  run_id: string;
  step_index: number;
  step_key: string;
  status: string;
  attempt: number;
  input: Json;
}

/** Enqueues a job atomically with the surrounding transaction. */
async function enqueueInTx(
  client: PoolClient,
  task: string,
  payload: unknown,
  opts?: { runAt?: Date; jobKey?: string },
): Promise<void> {
  await client.query(
    `SELECT graphile_worker.add_job(
       identifier := $1, payload := $2::json, run_at := coalesce($3, now()),
       max_attempts := 1, job_key := $4, job_key_mode := 'replace')`,
    [task, JSON.stringify(payload), opts?.runAt ?? null, opts?.jobKey ?? null],
  );
}

export function backoffDelayMs(attempt: number, backoff?: "none" | "exponential"): number {
  if (backoff === "none") return 0;
  return Math.min(2 ** attempt * 1000, 60_000);
}

/** Starts a run and kicks the first advance. */
export async function startRun(
  ctx: EngineContext,
  input: { flowVersionId: string; triggeredBy: Actor; runInput?: Json; triggerId?: string },
): Promise<string> {
  const client = await ctx.pool.connect();
  let runId: string;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO flow_runs (flow_version_id, trigger_id, triggered_by, input)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        input.flowVersionId,
        input.triggerId ?? null,
        JSON.stringify(input.triggeredBy),
        JSON.stringify(input.runInput ?? {}),
      ],
    );
    runId = rows[0]!.id;
    await recordEvent(client, {
      eventType: "run.created",
      actor: input.triggeredBy,
      entityType: "flow_run",
      entityId: runId,
      runId,
      // Redact the run input at WRITE time: this payload is hashed into the
      // immutable chain and shipped in the signed export, so a read-time mask
      // would come too late (see resolveRedactionHook).
      payload: {
        flowVersionId: input.flowVersionId,
        input: redactValue(resolveRedactionHook(), input.runInput ?? {}),
      },
    });
    // Enqueue the first advance INSIDE the transaction (graphile_worker writes to
    // the same Postgres), so the run row and its advance job commit atomically. A
    // crash between COMMIT and a separate enqueue would otherwise orphan the run
    // with no recovery sweep. advanceRun is idempotent, so a replay is safe.
    await enqueueInTx(client, TASK_ADVANCE, { runId }, { jobKey: `advance:${runId}` });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return runId;
}

/**
 * The orchestrator: finds the next undone step and acts on it. Idempotent —
 * a per-run advisory lock plus state re-checks make duplicate deliveries safe.
 */
export async function advanceRun(ctx: EngineContext, runId: string): Promise<void> {
  const pending: PendingWebhook[] = [];
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1::text))", [runId]);

    const runRes = await client.query<RunRow>(
      "SELECT id, flow_version_id, status, input FROM flow_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    const run = runRes.rows[0];
    if (!run) throw new Error(`run ${runId} not found`);
    if (["completed", "failed", "cancelled", "timed_out"].includes(run.status)) {
      await client.query("COMMIT");
      return;
    }

    const definition = await loadDefinition(client, run.flow_version_id);
    const nextIndex = await findNextStepIndex(client, runId, definition);

    if (nextIndex === null) {
      await client.query(
        "UPDATE flow_runs SET status = 'completed', finished_at = now() WHERE id = $1",
        [runId],
      );
      await recordEvent(client, {
        eventType: "run.completed",
        actor: SYSTEM,
        entityType: "flow_run",
        entityId: runId,
        runId,
        payload: {},
      });
      pending.push({ event: "run.finished", runId, data: { status: "completed" } });
      await client.query("COMMIT");
      firePendingWebhooks(ctx.pool, pending);
      return;
    }

    const step = definition.steps[nextIndex]!;

    if (isApprovalGate(step)) {
      const alreadyPending = await client.query(
        "SELECT 1 FROM approvals WHERE run_id = $1 AND step_index = $2 AND status = 'pending'",
        [runId, nextIndex],
      );
      if (alreadyPending.rows.length === 0) {
        const requiredApprovals = step.approvals?.min_approvals ?? 1;
        const approval = await client.query<{ id: string }>(
          `INSERT INTO approvals (run_id, step_index, step_key, required_approvals)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [runId, nextIndex, step.key, requiredApprovals],
        );
        await client.query("UPDATE flow_runs SET status = 'waiting_approval' WHERE id = $1", [
          runId,
        ]);
        await recordEvent(client, {
          eventType: "approval.requested",
          actor: SYSTEM,
          entityType: "approval",
          entityId: approval.rows[0]!.id,
          runId,
          payload: { stepKey: step.key, stepIndex: nextIndex, title: step.title, requiredApprovals },
        });
        pending.push({
          event: "approval.requested",
          runId,
          data: { approvalId: approval.rows[0]!.id, stepKey: step.key, title: step.title },
        });
      }
      await client.query("COMMIT");
      firePendingWebhooks(ctx.pool, pending);
      return;
    }

    // Agent step. Skip if an attempt is already in flight.
    const inFlight = await client.query(
      `SELECT 1 FROM step_runs
        WHERE run_id = $1 AND step_index = $2 AND status IN ('pending', 'running')`,
      [runId, nextIndex],
    );
    if (inFlight.rows.length > 0) {
      await client.query("COMMIT");
      return;
    }

    let enforced;
    try {
      enforced = await enforce(client, {
        agentName: step.agent,
        skillRefs: step.skills,
        runId,
        hasSeparationGate: definition.steps.slice(0, nextIndex).some(gateEnforcesSeparation),
      });
    } catch (err) {
      if (err instanceof EnforcementError) {
        await failRun(
          client,
          runId,
          `enforcement: ${err.message}`,
          {
            eventType:
              err.code === "sod_violation" ? "enforcement.sod_violation" : "enforcement.blocked",
            payload: { stepKey: step.key, code: err.code, reason: err.message },
          },
          pending,
        );
        await client.query("COMMIT");
        firePendingWebhooks(ctx.pool, pending);
        return;
      }
      throw err;
    }

    const attemptRes = await client.query<{ attempts: number }>(
      "SELECT count(*)::int AS attempts FROM step_runs WHERE run_id = $1 AND step_index = $2",
      [runId, nextIndex],
    );
    const attempt = attemptRes.rows[0]!.attempts + 1;
    const stepInput = await resolveStepInput(client, run, nextIndex);

    // Freeze the role's limits ONCE per (run, role). If this role already has a
    // step_run in this run (a prior attempt of this step, or an earlier step on
    // the same role), carry that frozen snapshot forward rather than re-reading
    // live limits. Otherwise a retry — or any later step on the same role —
    // would re-freeze from whatever roles.limits is NOW, so an admin editing the
    // role mid-run could raise the ceiling for an in-flight run. Read live only
    // on the role's first appearance, inside this advisory-locked transaction.
    // (Reassigning the agent to a DIFFERENT role mid-run is a separate, admin-
    // only path that still resolves the new role's limits; see SECURITY.md.)
    const frozen = await client.query<{ limits_snapshot: Json }>(
      `SELECT limits_snapshot FROM step_runs
        WHERE run_id = $1 AND role_id_snapshot = $2
        ORDER BY started_at ASC NULLS FIRST, attempt ASC, id ASC LIMIT 1`,
      [runId, enforced.roleId],
    );
    const limitsSnapshot =
      frozen.rows[0]?.limits_snapshot ?? (await getRoleLimits(client, enforced.roleId));

    // Freeze the agent's model_config ONCE per (run, agent), carried forward
    // across retries and later steps on the same agent. model_config is an
    // agent property, so a retry re-uses the original frozen model rather than
    // re-reading whatever agents.model_config is NOW — an admin editing the
    // agent mid-run cannot swap the model of an already-scheduled step. Read
    // live (enforced.modelConfig) only on the agent's first appearance.
    const frozenModel = await client.query<{ model_config_snapshot: Json }>(
      `SELECT model_config_snapshot FROM step_runs
        WHERE run_id = $1 AND agent_id = $2 AND model_config_snapshot IS NOT NULL
        ORDER BY started_at ASC NULLS FIRST, attempt ASC, id ASC LIMIT 1`,
      [runId, enforced.agentId],
    );
    const modelConfigSnapshot =
      frozenModel.rows[0]?.model_config_snapshot ?? enforced.modelConfig;

    const stepRun = await client.query<{ id: string }>(
      `INSERT INTO step_runs
         (run_id, step_index, step_key, agent_id, role_id_snapshot, limits_snapshot, model_config_snapshot, status, attempt, input, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9, now()) RETURNING id`,
      [
        runId,
        nextIndex,
        step.key,
        enforced.agentId,
        enforced.roleId,
        JSON.stringify(limitsSnapshot),
        JSON.stringify(modelConfigSnapshot),
        attempt,
        JSON.stringify(stepInput),
      ],
    );
    const stepRunId = stepRun.rows[0]!.id;

    await client.query(
      "UPDATE flow_runs SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = $1",
      [runId],
    );
    await recordEvent(client, {
      eventType: "run.step.started",
      actor: { type: "agent", id: enforced.agentId, name: step.agent },
      entityType: "step_run",
      entityId: stepRunId,
      runId,
      payload: { stepKey: step.key, stepIndex: nextIndex, attempt, skills: step.skills },
    });
    await enqueueInTx(client, TASK_EXECUTE_STEP, { stepRunId });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Executes one step attempt with a timeout; schedules retry or fails the run. */
export async function executeStep(ctx: EngineContext, stepRunId: string): Promise<void> {
  const loaded = await loadStepForExecution(ctx.pool, stepRunId);
  if (!loaded) return; // already handled (idempotency)
  const { stepRun, step, runId, hasSeparationGate, meta } = loaded;

  // Defensive re-enforcement at invocation time: grants or constraints may
  // have changed between scheduling and execution. Deny by default, twice.
  const blocked = await reEnforce(ctx, { step, runId, stepRunId, hasSeparationGate });
  if (blocked) return;

  const timeoutMs = step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("step timed out")), timeoutMs);

  let output: Json | null = null;
  let failure: { message: string; timedOut: boolean } | null = null;
  try {
    // Race against the abort signal so a hung skill cannot hang the engine;
    // the orphaned promise is abandoned and the watchdog covers the worst case.
    output = await Promise.race([
      ctx.executor.execute({ step, input: stepRun.input, signal: controller.signal, meta }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error("step timed out")),
        );
      }),
    ]);
  } catch (err) {
    failure = {
      message: (err as Error).message,
      timedOut: controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }

  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1::text))", [runId]);

    if (failure === null) {
      const updated = await client.query(
        `UPDATE step_runs SET status = 'completed', output = $2, finished_at = now()
           WHERE id = $1 AND status = 'running' RETURNING id`,
        [stepRunId, JSON.stringify(output)],
      );
      if (updated.rowCount === 0) {
        // The watchdog (or another delivery) already settled this attempt under
        // the same lock. Do not resurrect it: skip the completed event + advance.
        await client.query("COMMIT");
        return;
      }
      await recordEvent(client, {
        eventType: "run.step.completed",
        actor: { type: "agent", id: stepRun.agent_id, name: step.agent },
        entityType: "step_run",
        entityId: stepRunId,
        runId,
        // Redact the step output before it is hashed into the chain / exported.
        payload: {
          stepKey: stepRun.step_key,
          attempt: stepRun.attempt,
          output: redactValue(resolveRedactionHook(), output),
        },
      });
      await enqueueInTx(client, TASK_ADVANCE, { runId }, { jobKey: `advance:${runId}` });
      await client.query("COMMIT");
      return;
    }

    const pending: PendingWebhook[] = [];
    await handleStepFailure(
      client,
      {
        stepRunId,
        stepKey: stepRun.step_key,
        attempt: stepRun.attempt,
        runId,
        step,
        reason: failure.message,
        timedOut: failure.timedOut,
      },
      pending,
    );
    await client.query("COMMIT");
    firePendingWebhooks(ctx.pool, pending);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** A decision the gate's rules refuse; the API surfaces statusCode verbatim. */
export class ApprovalDecisionError extends Error {
  override name = "ApprovalDecisionError";
  constructor(
    readonly statusCode: 400 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

interface ApprovalRow {
  id: string;
  run_id: string;
  step_key: string;
  step_index: number;
  status: string;
  required_approvals: number;
  flow_version_id: string;
  triggered_by: { type?: string; id?: string };
}

/**
 * Records a human decision on a pending approval gate (n-of-m aware).
 *
 * Gates WITHOUT an `approvals` object behave exactly as before: one decision,
 * no identity requirement. Gates WITH one switch to identity mode and FAIL
 * CLOSED: decisions must come from authenticated users, named approver lists
 * are exclusive, the run's requester is forbidden unless explicitly allowed,
 * and the same user can never decide twice. Any single rejection resolves the
 * gate; it approves when the approved count reaches required_approvals.
 */
export async function decideApproval(
  ctx: EngineContext,
  input: {
    approvalId: string;
    decision: "approved" | "rejected";
    decidedBy: Actor;
    userId?: string;
    userEmail?: string;
    reason?: string;
  },
): Promise<void> {
  const pending: PendingWebhook[] = [];
  // A denial is audited and COMMITTED, then surfaced; collect it here so the
  // transaction block can finish cleanly before throwing.
  let denial: ApprovalDecisionError | null = null;
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ApprovalRow>(
      `SELECT ap.id, ap.run_id, ap.step_key, ap.step_index, ap.status,
              ap.required_approvals, fr.flow_version_id, fr.triggered_by
         FROM approvals ap
         JOIN flow_runs fr ON fr.id = ap.run_id
        WHERE ap.id = $1
          FOR UPDATE OF ap`,
      [input.approvalId],
    );
    const approval = rows[0];
    if (!approval) throw new Error(`approval ${input.approvalId} not found`);
    if (approval.status !== "pending") {
      throw new ApprovalDecisionError(
        409,
        `approval ${input.approvalId} already ${approval.status}`,
      );
    }

    const definition = await loadDefinition(client, approval.flow_version_id);
    const gate = definition.steps[approval.step_index];
    const gateApprovals = gate && isApprovalGate(gate) ? gate.approvals : undefined;

    const denied = await checkDecisionIdentity(client, approval, gateApprovals, input);
    if (denied) {
      // The denial audit event must survive; commit it, then surface the error.
      await client.query("COMMIT");
      denial = denied;
    } else {
      await applyDecision(client, approval, gateApprovals, input, pending);
      await client.query("COMMIT");
      firePendingWebhooks(ctx.pool, pending);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (denial) throw denial;
}

/** The admit path of decideApproval: duplicate check, decision row, tally, resolution. */
async function applyDecision(
  client: PoolClient,
  approval: ApprovalRow,
  gateApprovals: ApprovalGateApprovalsDef | undefined,
  input: {
    decision: "approved" | "rejected";
    decidedBy: Actor;
    userId?: string;
    userEmail?: string;
    reason?: string;
  },
  pending: PendingWebhook[],
): Promise<void> {
  if (input.userId) {
    const dup = await client.query(
      "SELECT 1 FROM approval_decisions WHERE approval_id = $1 AND decided_by_user_id = $2",
      [approval.id, input.userId],
    );
    if (dup.rows.length > 0) {
      throw new ApprovalDecisionError(
        409,
        `user has already decided approval ${approval.id}; the same user cannot decide twice`,
      );
    }
  }

  await client.query(
    `INSERT INTO approval_decisions
       (approval_id, decided_by_user_id, decided_by_label, decision, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      approval.id,
      input.userId ?? null,
      input.decidedBy.name ?? null,
      input.decision,
      input.reason ?? null,
    ],
  );
  const tallyRes = await client.query<{ approved: number; rejected: number }>(
    `SELECT count(*) FILTER (WHERE decision = 'approved')::int AS approved,
            count(*) FILTER (WHERE decision = 'rejected')::int AS rejected
       FROM approval_decisions WHERE approval_id = $1`,
    [approval.id],
  );
  const tally = tallyRes.rows[0]!;
  await recordEvent(client, {
    eventType: "approval.decided",
    actor: input.decidedBy,
    entityType: "approval",
    entityId: approval.id,
    runId: approval.run_id,
    payload: {
      stepKey: approval.step_key,
      decision: input.decision,
      reason: input.reason ?? null,
      approvedCount: tally.approved,
      rejectedCount: tally.rejected,
      requiredApprovals: approval.required_approvals,
    },
  });

  if (input.decision === "rejected") {
    // Any single rejection resolves the gate.
    await resolveApproval(client, approval, "rejected", input, gateApprovals, tally);
    await failRun(
      client,
      approval.run_id,
      `approval "${approval.step_key}" rejected`,
      undefined,
      pending,
    );
  } else if (tally.approved >= approval.required_approvals) {
    await resolveApproval(client, approval, "approved", input, gateApprovals, tally);
    await client.query(
      "UPDATE flow_runs SET status = 'running' WHERE id = $1 AND status = 'waiting_approval'",
      [approval.run_id],
    );
    await enqueueInTx(client, TASK_ADVANCE, { runId: approval.run_id }, {
      jobKey: `advance:${approval.run_id}`,
    });
  }
  // else: quorum not yet reached — the gate stays pending.
}

/**
 * Identity rules for a gate — FAIL CLOSED. Returns the error to surface after
 * the denial audit event commits, or null when the decision may proceed.
 *
 * In strict mode (MAKERCHECKER_REQUIRE_IDENTITY_GATES=1) every gate is bound by
 * forbid_requester regardless of how it was authored — a legacy gate, or one
 * that set forbid_requester:false before strict mode was enabled — so a
 * pre-strict, immutable flow version still fails closed: an authenticated
 * decision is required and the run's own requester (admin included) is denied.
 */
async function checkDecisionIdentity(
  client: PoolClient,
  approval: ApprovalRow,
  gateApprovals: ApprovalGateApprovalsDef | undefined,
  input: { decision: string; decidedBy: Actor; userId?: string; userEmail?: string },
): Promise<ApprovalDecisionError | null> {
  const strict = strictSod();
  if (!gateApprovals && !strict) return null;

  const forbidRequester = strict ? true : (gateApprovals?.forbid_requester ?? true);
  const approverEmails = gateApprovals?.approver_emails;
  const needsIdentity =
    strict || approval.required_approvals > 1 || approverEmails !== undefined || forbidRequester;

  const deny = async (code: string, message: string): Promise<ApprovalDecisionError> => {
    await recordEvent(client, {
      eventType: "approval.decision_denied",
      actor: input.decidedBy,
      entityType: "approval",
      entityId: approval.id,
      runId: approval.run_id,
      payload: {
        stepKey: approval.step_key,
        attemptedDecision: input.decision,
        code,
        reason: message,
      },
    });
    return new ApprovalDecisionError(403, message);
  };

  if (needsIdentity && !input.userId) {
    return deny("unauthenticated", "this gate requires an authenticated decision");
  }
  if (approverEmails && (!input.userEmail || !approverEmails.includes(input.userEmail))) {
    return deny(
      "not_named_approver",
      `user "${input.userEmail ?? "unknown"}" is not a named approver for gate ` +
        `"${approval.step_key}"`,
    );
  }
  if (
    forbidRequester &&
    approval.triggered_by.type === "user" &&
    approval.triggered_by.id !== undefined &&
    approval.triggered_by.id === input.userId
  ) {
    return deny(
      "requester_forbidden",
      `the user who triggered this run cannot decide gate "${approval.step_key}" ` +
        "(forbid_requester)",
    );
  }
  return null;
}

/** Marks the approvals row terminal and, in identity mode, audits the resolution. */
async function resolveApproval(
  client: PoolClient,
  approval: ApprovalRow,
  outcome: "approved" | "rejected",
  input: { decidedBy: Actor; userId?: string; reason?: string },
  gateApprovals: ApprovalGateApprovalsDef | undefined,
  tally: { approved: number; rejected: number },
): Promise<void> {
  await client.query(
    `UPDATE approvals SET status = $2, decided_by_user_id = $3, decided_at = now(), reason = $4
      WHERE id = $1`,
    [approval.id, outcome, input.userId ?? null, input.reason ?? null],
  );
  // Legacy single-decision gates resolve with approval.decided alone, exactly
  // as before; approval.resolved is the n-of-m settlement record.
  if (gateApprovals) {
    await recordEvent(client, {
      eventType: "approval.resolved",
      actor: input.decidedBy,
      entityType: "approval",
      entityId: approval.id,
      runId: approval.run_id,
      payload: {
        stepKey: approval.step_key,
        outcome,
        approvedCount: tally.approved,
        rejectedCount: tally.rejected,
        requiredApprovals: approval.required_approvals,
      },
    });
  }
}

export function createHandlers(ctx: EngineContext): Record<string, TaskHandler> {
  return {
    [TASK_ADVANCE]: async (payload) => {
      const { runId } = payload as { runId: string };
      await advanceRun(ctx, runId);
    },
    [TASK_EXECUTE_STEP]: async (payload) => {
      const { stepRunId } = payload as { stepRunId: string };
      await executeStep(ctx, stepRunId);
    },
  };
}

/**
 * Marks a failed/timed-out step attempt and either schedules the next attempt
 * or fails the run. Shared by executeStep and the watchdog; caller must hold
 * the run advisory lock inside an open transaction.
 */
export async function handleStepFailure(
  client: PoolClient,
  args: {
    stepRunId: string;
    stepKey: string;
    attempt: number;
    runId: string;
    step: AgentStepDef;
    reason: string;
    timedOut: boolean;
  },
  pending?: PendingWebhook[],
): Promise<void> {
  const status = args.timedOut ? "timed_out" : "failed";
  const updated = await client.query(
    `UPDATE step_runs SET status = $2, error = $3, finished_at = now()
       WHERE id = $1 AND status = 'running' RETURNING id`,
    [args.stepRunId, status, JSON.stringify({ message: args.reason })],
  );
  if (updated.rowCount === 0) {
    // Another actor (the watchdog, or a retried delivery) already settled this
    // attempt under the same lock. Skip the retry/failed audit events and
    // failRun so the terminal state is never double-emitted. The watchdog caller
    // re-checks status='running' before calling here, so it is unaffected.
    return;
  }

  // Error/reason text is attacker-influenced (e.g. a forwarded MCP/HTTP skill
  // error) and can carry secrets, so redact it before it enters the audit chain.
  const redactedReason = redactValue(resolveRedactionHook(), args.reason);
  const maxAttempts = args.step.retries?.max_attempts ?? 1;
  if (args.attempt < maxAttempts) {
    const delay = backoffDelayMs(args.attempt, args.step.retries?.backoff);
    const runAt = new Date(Date.now() + delay);
    await recordEvent(client, {
      eventType: "run.step.retrying",
      actor: SYSTEM,
      entityType: "step_run",
      entityId: args.stepRunId,
      runId: args.runId,
      payload: {
        stepKey: args.stepKey,
        failedAttempt: args.attempt,
        nextAttempt: args.attempt + 1,
        maxAttempts,
        reason: redactedReason,
        timedOut: args.timedOut,
        retryAt: runAt.toISOString(),
      },
    });
    await enqueueInTx(client, TASK_ADVANCE, { runId: args.runId }, {
      runAt,
      jobKey: `advance:${args.runId}`,
    });
  } else {
    await recordEvent(client, {
      eventType: "run.step.failed",
      actor: SYSTEM,
      entityType: "step_run",
      entityId: args.stepRunId,
      runId: args.runId,
      payload: {
        stepKey: args.stepKey,
        attempt: args.attempt,
        maxAttempts,
        reason: redactedReason,
        timedOut: args.timedOut,
      },
    });
    await failRun(
      client,
      args.runId,
      `step "${args.stepKey}" failed after ${args.attempt} attempt(s): ${args.reason}`,
      undefined,
      pending,
    );
  }
}

// --- internals ---

async function findNextStepIndex(
  client: PoolClient,
  runId: string,
  definition: FlowDefinition,
): Promise<number | null> {
  const completedSteps = await client.query<{ step_index: number }>(
    "SELECT DISTINCT step_index FROM step_runs WHERE run_id = $1 AND status = 'completed'",
    [runId],
  );
  const approvedGates = await client.query<{ step_index: number }>(
    "SELECT step_index FROM approvals WHERE run_id = $1 AND status = 'approved'",
    [runId],
  );
  const done = new Set<number>([
    ...completedSteps.rows.map((r) => r.step_index),
    ...approvedGates.rows.map((r) => r.step_index),
  ]);
  for (let i = 0; i < definition.steps.length; i += 1) {
    if (!done.has(i)) return i;
  }
  return null;
}

async function resolveStepInput(client: PoolClient, run: RunRow, stepIndex: number): Promise<Json> {
  const prev = await client.query<{ output: Json }>(
    `SELECT output FROM step_runs
      WHERE run_id = $1 AND step_index < $2 AND status = 'completed'
      ORDER BY step_index DESC LIMIT 1`,
    [run.id, stepIndex],
  );
  return prev.rows[0]?.output ?? run.input;
}

/** Re-runs enforcement at invocation time; returns true if the run was blocked. */
async function reEnforce(
  ctx: EngineContext,
  args: { step: AgentStepDef; runId: string; stepRunId: string; hasSeparationGate: boolean },
): Promise<boolean> {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1::text))", [args.runId]);
    try {
      await enforce(client, {
        agentName: args.step.agent,
        skillRefs: args.step.skills,
        runId: args.runId,
        hasSeparationGate: args.hasSeparationGate,
      });
      await client.query("COMMIT");
      return false;
    } catch (err) {
      if (!(err instanceof EnforcementError)) throw err;
      const pending: PendingWebhook[] = [];
      await client.query(
        `UPDATE step_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
        [args.stepRunId, JSON.stringify({ message: err.message })],
      );
      await failRun(
        client,
        args.runId,
        `enforcement: ${err.message}`,
        {
          eventType:
            err.code === "sod_violation" ? "enforcement.sod_violation" : "enforcement.blocked",
          payload: { stepKey: args.step.key, code: err.code, reason: err.message, at: "invocation" },
        },
        pending,
      );
      await client.query("COMMIT");
      firePendingWebhooks(ctx.pool, pending);
      return true;
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function loadStepForExecution(
  pool: Pool,
  stepRunId: string,
): Promise<{
  stepRun: StepRunRow & { agent_id: string };
  step: AgentStepDef;
  runId: string;
  hasSeparationGate: boolean;
  meta: StepExecutionMeta;
} | null> {
  const { rows } = await pool.query<
    StepRunRow & {
      agent_id: string;
      role_id_snapshot: string;
      model_config_snapshot: Json | null;
      flow_version_id: string;
      agent_name: string;
      model_config: Json;
    }
  >(
    // Read the FROZEN model_config taken at scheduling; fall back to the live
    // a.model_config only when the snapshot is null (step_runs scheduled before
    // migration 0008), never silently swapping the model of an in-flight run.
    `SELECT sr.id, sr.run_id, sr.step_index, sr.step_key, sr.status, sr.attempt, sr.input,
            sr.agent_id, sr.role_id_snapshot, sr.model_config_snapshot,
            fr.flow_version_id, a.name AS agent_name, a.model_config
       FROM step_runs sr
       JOIN flow_runs fr ON fr.id = sr.run_id
       JOIN agents a ON a.id = sr.agent_id
      WHERE sr.id = $1`,
    [stepRunId],
  );
  const stepRun = rows[0];
  if (!stepRun || stepRun.status !== "running") return null;

  const def = await pool.query<{ definition: FlowDefinition }>(
    "SELECT definition FROM flow_versions WHERE id = $1",
    [stepRun.flow_version_id],
  );
  const definition = def.rows[0]!.definition;
  const step = definition.steps[stepRun.step_index];
  if (!step || isApprovalGate(step)) {
    throw new Error(`step_run ${stepRunId} does not reference an agent step`);
  }
  return {
    stepRun,
    step,
    runId: stepRun.run_id,
    hasSeparationGate: definition.steps.slice(0, stepRun.step_index).some(gateEnforcesSeparation),
    meta: {
      runId: stepRun.run_id,
      stepRunId: stepRun.id,
      agentId: stepRun.agent_id,
      agentName: stepRun.agent_name,
      roleId: stepRun.role_id_snapshot,
      modelConfig: stepRun.model_config_snapshot ?? stepRun.model_config,
    },
  };
}

async function failRun(
  client: PoolClient,
  runId: string,
  reason: string,
  blockEvent?: { eventType: string; payload: Json },
  pending?: PendingWebhook[],
): Promise<void> {
  pending?.push({ event: "run.failed", runId, data: { reason } });
  await client.query(
    "UPDATE flow_runs SET status = 'failed', failure_reason = $2, finished_at = now() WHERE id = $1",
    [runId, reason],
  );
  if (blockEvent) {
    await recordEvent(client, {
      eventType: blockEvent.eventType,
      actor: SYSTEM,
      entityType: "flow_run",
      entityId: runId,
      runId,
      payload: blockEvent.payload,
    });
  }
  await recordEvent(client, {
    eventType: "run.failed",
    actor: SYSTEM,
    entityType: "flow_run",
    entityId: runId,
    // The reason may embed an attacker-influenced step error; redact at write
    // time so it does not enter the chain / signed export in the clear.
    runId,
    payload: { reason: redactValue(resolveRedactionHook(), reason) },
  });
}
