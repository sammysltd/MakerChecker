import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { GraphileWorkerBackend } from "./graphile-backend.js";
import { LocalSkillExecutor, type Json, type LocalSkillFn } from "./executor.js";
import { publishFlowVersion } from "./flows.js";
import { createHandlers, startRun, type EngineContext } from "./orchestrator.js";

/**
 * The executors redact their own skill.invoked / llm.call payloads, but the
 * ORCHESTRATOR records run.created (input), run.step.completed (output), and the
 * failure events (reason) itself. Those payloads are hashed into the immutable
 * chain and shipped verbatim in the signed regulator export, so a read-time mask
 * would be too late — they must be redacted at WRITE time too. This suite plants
 * a secret in run input, step output, and a step error and asserts each is
 * MASKED in the audit_events row (= what the signed export reads), while the
 * at-rest step_runs columns stay raw (encryption is a deployment concern).
 */

const SECRET_EMAIL = "victim@private.example";
const SECRET_ACCT = "4012888888881881";
const REDACTED_EMAIL = "[REDACTED:email]";
const REDACTED_NUMBER = "[REDACTED:number]";

let db: TestDb;
let ctx: EngineContext;
let prevRedaction: string | undefined;
const registry = new Map<string, LocalSkillFn>();
const USER = { type: "user" as const, id: "redact-user", name: "Redact User" };

beforeAll(async () => {
  prevRedaction = process.env.MAKERCHECKER_REDACTION;
  process.env.MAKERCHECKER_REDACTION = "example";
  db = await createTestDb();
  const backend = new GraphileWorkerBackend(db.pool, 5);
  ctx = { pool: db.pool, backend, executor: new LocalSkillExecutor(registry) };
  await backend.start(createHandlers(ctx));

  // A skill that echoes input and emits a secret in its output.
  await seedSkill("echoer@1", async (input: Json) => ({
    echoed: input,
    leak: `account ${SECRET_ACCT} flagged`,
  }));
  // A skill that throws with the secret in the error message.
  await seedSkill("boomer@1", async () => {
    throw new Error(`wire to ${SECRET_EMAIL} (acct ${SECRET_ACCT}) failed`);
  });
  await seedAgent("redact-agent");
  await grant("redact-agent", "echoer@1");
  await grant("redact-agent", "boomer@1");
}, 60_000);

afterAll(async () => {
  await ctx.backend.stop();
  await db.drop();
  if (prevRedaction === undefined) delete process.env.MAKERCHECKER_REDACTION;
  else process.env.MAKERCHECKER_REDACTION = prevRedaction;
});

async function seedAgent(name: string, roleName = `${name}-role`): Promise<void> {
  await db.pool.query(
    `WITH role AS (INSERT INTO roles (name) VALUES ($2) RETURNING id)
     INSERT INTO agents (name, role_id) SELECT $1, id FROM role`,
    [name, roleName],
  );
}

async function seedSkill(ref: string, fn: LocalSkillFn): Promise<void> {
  const [name, version] = ref.split("@");
  await db.pool.query(
    `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
     VALUES ($1, $2, '{}', '{}', '{"type":"local"}', 'low')`,
    [name, Number(version)],
  );
  registry.set(ref, fn);
}

async function grant(agentName: string, ref: string): Promise<void> {
  const [name, version] = ref.split("@");
  await db.pool.query(
    `INSERT INTO role_skill_grants (role_id, skill_id)
     SELECT a.role_id, s.id FROM agents a, skills s
      WHERE a.name = $1 AND s.name = $2 AND s.version = $3`,
    [agentName, name, Number(version)],
  );
}

async function publish(name: string, skill: string): Promise<string> {
  const v = await publishFlowVersion(db.pool, {
    actor: USER,
    definition: { name, steps: [{ key: "go", agent: "redact-agent", skills: [skill] }] },
  });
  return v.flowVersionId;
}

async function waitForStatus(runId: string, statuses: string[], timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.pool.query<{ status: string }>(
      "SELECT status FROM flow_runs WHERE id = $1",
      [runId],
    );
    if (statuses.includes(rows[0]!.status)) return rows[0]!.status;
    if (Date.now() > deadline) throw new Error(`run ${runId} stuck at "${rows[0]!.status}"`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function payloadOf(runId: string, eventType: string): Promise<Record<string, unknown>> {
  const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM audit_events WHERE run_id = $1 AND event_type = $2 ORDER BY seq DESC LIMIT 1",
    [runId, eventType],
  );
  expect(rows[0], `no ${eventType} event for ${runId}`).toBeDefined();
  return rows[0]!.payload;
}

describe("orchestrator write-path redaction", () => {
  it("masks run input (run.created) and step output (run.step.completed) in the chain", async () => {
    const fvId = await publish("redact-echo-flow", "echoer@1");
    const runId = await startRun(ctx, {
      flowVersionId: fvId,
      triggeredBy: USER,
      runInput: { note: `contact ${SECRET_EMAIL}`, account: SECRET_ACCT },
    });
    expect(await waitForStatus(runId, ["completed", "failed"])).toBe("completed");

    // run.created input is masked in the audit chain (= the signed export source).
    const created = await payloadOf(runId, "run.created");
    expect(JSON.stringify(created)).not.toContain(SECRET_EMAIL);
    expect(JSON.stringify(created)).not.toContain(SECRET_ACCT);
    expect((created.input as Record<string, unknown>).note).toBe(`contact ${REDACTED_EMAIL}`);
    expect((created.input as Record<string, unknown>).account).toBe(REDACTED_NUMBER);

    // run.step.completed output is masked — the exact gap the red-team found.
    const completed = await payloadOf(runId, "run.step.completed");
    expect(JSON.stringify(completed)).not.toContain(SECRET_ACCT);
    expect((completed.output as Record<string, unknown>).leak).toBe(
      `account ${REDACTED_NUMBER} flagged`,
    );

    // At-rest step_runs.output stays RAW (the hook governs exposure, not storage).
    const { rows } = await db.pool.query<{ output: Record<string, unknown> }>(
      "SELECT output FROM step_runs WHERE run_id = $1 ORDER BY attempt DESC LIMIT 1",
      [runId],
    );
    expect(JSON.stringify(rows[0]!.output)).toContain(SECRET_ACCT);
  });

  it("masks the failure reason (run.step.failed / run.failed) in the chain", async () => {
    const fvId = await publish("redact-boom-flow", "boomer@1");
    const runId = await startRun(ctx, { flowVersionId: fvId, triggeredBy: USER, runInput: {} });
    expect(await waitForStatus(runId, ["completed", "failed"])).toBe("failed");

    for (const eventType of ["run.step.failed", "run.failed"]) {
      const payload = await payloadOf(runId, eventType);
      const serialized = JSON.stringify(payload);
      expect(serialized, `${eventType} leaked email`).not.toContain(SECRET_EMAIL);
      expect(serialized, `${eventType} leaked account`).not.toContain(SECRET_ACCT);
      expect(String(payload.reason)).toContain(REDACTED_EMAIL);
      expect(String(payload.reason)).toContain(REDACTED_NUMBER);
    }
  });
});
