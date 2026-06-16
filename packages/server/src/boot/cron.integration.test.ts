import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeWorkerUtils } from "graphile-worker";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { seedDemo } from "../demo/seed.js";
import { GraphileWorkerBackend } from "../engine/graphile-backend.js";
import { LocalSkillExecutor, type LocalSkillFn } from "../engine/executor.js";
import { publishFlowVersion } from "../engine/flows.js";
import type { EngineContext } from "../engine/orchestrator.js";
import { createCronTriggerHandler, loadCronItems, TASK_CRON_TRIGGER } from "./cron.js";

const USER = { type: "user" as const, id: "cron-user", name: "Cron Tester" };

let db: TestDb;
let ctx: EngineContext;
let handler: ReturnType<typeof createCronTriggerHandler>;
let demoTriggerId: string;

const registry = new Map<string, LocalSkillFn>();

async function insertTrigger(
  flowName: string,
  type: string,
  config: Record<string, unknown>,
  enabled = true,
): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO flow_triggers (flow_id, type, config, enabled)
     SELECT id, $2, $3, $4 FROM flows WHERE name = $1 RETURNING id`,
    [flowName, type, JSON.stringify(config), enabled],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedDemo(db.pool);
  const { rows } = await db.pool.query<{ id: string }>(
    "SELECT id FROM flow_triggers WHERE type = 'cron'",
  );
  demoTriggerId = rows[0]!.id;

  // startRun enqueues the first advance in the same transaction (via
  // graphile_worker.add_job), so the worker schema must exist before any run is
  // started. Install it here without a runner: this suite intentionally has no
  // worker, so the runs it starts sit queued, which is what we want to inspect.
  const utils = await makeWorkerUtils({ pgPool: db.pool });
  await utils.migrate();
  await utils.release();

  // The handler only needs enqueue (no runner): runs it starts sit queued,
  // which is exactly what we want to inspect.
  const backend = new GraphileWorkerBackend(db.pool, 1);
  ctx = { pool: db.pool, backend, executor: new LocalSkillExecutor(registry) };
  handler = createCronTriggerHandler(ctx);
}, 60_000);

afterAll(async () => {
  await ctx.backend.stop();
  await db.drop();
});

describe("loadCronItems — registration from seeded triggers", () => {
  it("parses the demo seed's schedule into exactly one cron item", async () => {
    const items = await loadCronItems(db.pool);
    expect(items).toHaveLength(1);
    expect(items[0]!.task).toBe(TASK_CRON_TRIGGER);
    expect(items[0]!.identifier).toBe(`trigger-${demoTriggerId}`);
    expect(items[0]!.payload).toEqual({ triggerId: demoTriggerId });
    // "0 7 * * 1-5": fires weekdays at 07:00 and nowhere near midnight Sunday.
    expect(items[0]!.match({ min: 0, hour: 7, date: 2, month: 2, dow: 2 })).toBe(true);
    expect(items[0]!.match({ min: 0, hour: 7, date: 1, month: 2, dow: 0 })).toBe(false);
    expect(items[0]!.match({ min: 30, hour: 7, date: 2, month: 2, dow: 2 })).toBe(false);
  });

  it("SKIPS triggers with missing or unparseable schedules without failing boot", async () => {
    const missing = await insertTrigger("self-approval-attempt", "cron", {});
    const garbage = await insertTrigger("self-approval-attempt", "cron", {
      schedule: "every blue moon",
    });
    const disabled = await insertTrigger(
      "self-approval-attempt",
      "cron",
      { schedule: "*/5 * * * *" },
      false,
    );
    const valid = await insertTrigger("high-value-payment", "cron", { schedule: "30 6 * * *" });

    const items = await loadCronItems(db.pool);
    const identifiers = items.map((i) => i.identifier);
    expect(identifiers).toContain(`trigger-${demoTriggerId}`);
    expect(identifiers).toContain(`trigger-${valid}`);
    expect(identifiers).not.toContain(`trigger-${missing}`);
    expect(identifiers).not.toContain(`trigger-${garbage}`);
    expect(identifiers).not.toContain(`trigger-${disabled}`);
    expect(items).toHaveLength(2);
  });

  it("ignores non-cron trigger types entirely", async () => {
    const manual = await insertTrigger("self-approval-attempt", "manual", {
      schedule: "* * * * *",
    });
    const items = await loadCronItems(db.pool);
    expect(items.map((i) => i.identifier)).not.toContain(`trigger-${manual}`);
  });
});

describe("trigger.cron handler", () => {
  it("starts a run of the latest published flow version as system/cron", async () => {
    // Publish a v2 so "latest published" is actually distinguishable from v1.
    const v2 = await publishFlowVersion(db.pool, {
      actor: USER,
      definition: {
        name: "daily-cash-reconciliation",
        steps: [
          {
            key: "prepare",
            agent: "recon-preparer",
            skills: ["csv-ingest@1", "txn-match@1"],
            instructions: "v2 of the recon flow.",
          },
        ],
      },
    });
    expect(v2.version).toBe(2);

    await handler({ triggerId: demoTriggerId });

    const { rows } = await db.pool.query<{
      flow_version_id: string;
      trigger_id: string;
      triggered_by: Record<string, unknown>;
    }>(
      "SELECT flow_version_id, trigger_id, triggered_by FROM flow_runs WHERE trigger_id = $1",
      [demoTriggerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.flow_version_id).toBe(v2.flowVersionId);
    expect(rows[0]!.triggered_by).toEqual({ type: "system", name: "cron" });

    // Audit-first: the run's creation is on the chain, attributed to cron.
    const audit = await db.pool.query<{ actor: Record<string, unknown> }>(
      `SELECT actor FROM audit_events ae
        JOIN flow_runs fr ON fr.id = ae.run_id
       WHERE fr.trigger_id = $1 AND ae.event_type = 'run.created'`,
      [demoTriggerId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor).toEqual({ type: "system", name: "cron" });
  });

  it("fails closed on a payload without a triggerId", async () => {
    await expect(handler({})).rejects.toThrow(/missing triggerId/);
    await expect(handler(null)).rejects.toThrow(/missing triggerId/);
  });

  it("fails closed on an unknown trigger", async () => {
    await expect(
      handler({ triggerId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/missing or not a cron trigger/);
  });

  it("fails closed when the trigger exists but is not a cron trigger", async () => {
    const manual = await insertTrigger("self-approval-attempt", "manual", {});
    await expect(handler({ triggerId: manual })).rejects.toThrow(
      /missing or not a cron trigger/,
    );
  });

  it("a trigger disabled after boot quietly stops starting runs", async () => {
    const disabledLater = await insertTrigger("self-approval-attempt", "cron", {
      schedule: "0 8 * * *",
    });
    await db.pool.query("UPDATE flow_triggers SET enabled = false WHERE id = $1", [
      disabledLater,
    ]);
    await expect(handler({ triggerId: disabledLater })).resolves.toBeUndefined();
    const { rows } = await db.pool.query("SELECT 1 FROM flow_runs WHERE trigger_id = $1", [
      disabledLater,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("refuses loudly when the flow has no published version", async () => {
    await db.pool.query("INSERT INTO flows (name) VALUES ('cron-orphan-flow')");
    const orphan = await insertTrigger("cron-orphan-flow", "cron", { schedule: "0 9 * * *" });
    await expect(handler({ triggerId: orphan })).rejects.toThrow(/no published version/);
    const { rows } = await db.pool.query("SELECT 1 FROM flow_runs WHERE trigger_id = $1", [
      orphan,
    ]);
    expect(rows).toHaveLength(0);
  });
});
