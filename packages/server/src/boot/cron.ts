import { parseCronItems, type ParsedCronItem } from "graphile-worker";
import type { Pool } from "pg";

import type { TaskHandler } from "../engine/backend.js";
import { startRun, type EngineContext } from "../engine/orchestrator.js";
import { workerLogger } from "./logger.js";

export const TASK_CRON_TRIGGER = "trigger.cron";

const CRON_ACTOR = { type: "system" as const, name: "cron" };

interface CronTriggerRow {
  id: string;
  flow_name: string;
  config: { schedule?: unknown };
}

/**
 * Builds graphile-worker cron items from enabled `cron` flow_triggers (one
 * per trigger, schedule taken from config.schedule). Triggers with a missing
 * or unparseable schedule are SKIPPED with a logged error — a broken
 * schedule must never fire, and must never stop the rest of the instance
 * from booting.
 */
export async function loadCronItems(pool: Pool): Promise<ParsedCronItem[]> {
  const { rows } = await pool.query<CronTriggerRow>(
    `SELECT t.id, t.config, f.name AS flow_name
       FROM flow_triggers t
       JOIN flows f ON f.id = t.flow_id
      WHERE t.type = 'cron' AND t.enabled
      ORDER BY t.created_at`,
  );

  const items: ParsedCronItem[] = [];
  for (const row of rows) {
    const schedule = row.config?.schedule;
    if (typeof schedule !== "string" || schedule.trim() === "") {
      workerLogger.error(
        { triggerId: row.id, flow: row.flow_name },
        "cron: trigger has no usable config.schedule; skipping",
      );
      continue;
    }
    try {
      items.push(
        ...parseCronItems([
          {
            task: TASK_CRON_TRIGGER,
            match: schedule,
            identifier: `trigger-${row.id}`,
            payload: { triggerId: row.id },
          },
        ]),
      );
    } catch (err) {
      workerLogger.error(
        { triggerId: row.id, flow: row.flow_name, schedule, err: { message: (err as Error).message } },
        "cron: trigger schedule did not parse; skipping",
      );
    }
  }
  return items;
}

/**
 * The trigger.cron task: starts a run of the trigger's flow at its latest
 * published version, as {type:'system', name:'cron'}. Fails closed — the
 * trigger is re-checked at fire time, so one disabled after boot quietly
 * stops starting runs without a restart, and a missing trigger or a flow
 * with no published version refuses loudly.
 */
export function createCronTriggerHandler(ctx: EngineContext): TaskHandler {
  return async (payload) => {
    const { triggerId } = (payload ?? {}) as { triggerId?: string };
    if (!triggerId) {
      throw new Error("trigger.cron payload missing triggerId");
    }
    const trigger = await ctx.pool.query<{ flow_id: string; enabled: boolean; type: string }>(
      "SELECT flow_id, enabled, type FROM flow_triggers WHERE id = $1",
      [triggerId],
    );
    const row = trigger.rows[0];
    if (!row || row.type !== "cron") {
      throw new Error(`trigger.cron: trigger ${triggerId} is missing or not a cron trigger`);
    }
    if (!row.enabled) {
      workerLogger.error({ triggerId }, "cron: trigger fired but is disabled; not starting a run");
      return;
    }
    const version = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM flow_versions
        WHERE flow_id = $1 AND status = 'published'
        ORDER BY version DESC LIMIT 1`,
      [row.flow_id],
    );
    if (!version.rows[0]) {
      throw new Error(
        `trigger.cron: flow for trigger ${triggerId} has no published version; refusing`,
      );
    }
    await startRun(ctx, {
      flowVersionId: version.rows[0].id,
      triggeredBy: CRON_ACTOR,
      triggerId,
    });
  };
}
