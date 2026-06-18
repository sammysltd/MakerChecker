import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import type { LLMProvider, LLMRequest, LLMTurn } from "../llm/provider.js";
import { checkAndAuthorize, openSession } from "../proxy/service.js";
import { SkillInvoker } from "../skills/invoker.js";
import { SequentialInvokerExecutor } from "../skills/sequential-executor.js";
import type { LocalSkillFn } from "./executor.js";
import { GraphileWorkerBackend } from "./graphile-backend.js";
import { LLMExecutor, toolNameForRef } from "./llm-executor.js";
import { checkSkillLimit, checkTokenBudget } from "./limits.js";
import { publishFlowVersion } from "./flows.js";
import { createHandlers, startRun, type EngineContext } from "./orchestrator.js";

/**
 * Role limits & budgets (M11). Every cap is attacked: invocation caps mid-run,
 * amount ceilings, MISSING amount fields (the fail-closed proof), unreadable
 * limit configs, token budgets that must trip BEFORE the provider is paid,
 * and proxy sessions that must honour the same per-skill caps.
 */

let db: TestDb;
let ctx: EngineContext;
const registry = new Map<string, LocalSkillFn>();

const USER = { type: "user" as const, id: "limits-user", name: "Limits Tester" };

beforeAll(async () => {
  db = await createTestDb();
  const backend = new GraphileWorkerBackend(db.pool, 5);
  const invoker = new SkillInvoker(db.pool, registry);
  ctx = { pool: db.pool, backend, executor: new SequentialInvokerExecutor(invoker, db.pool) };
  await backend.start(createHandlers(ctx));
}, 60_000);

afterAll(async () => {
  await ctx.backend.stop();
  await db.drop();
});

async function seedRole(name: string, limits: Record<string, unknown>): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO roles (name, limits) VALUES ($1, $2) RETURNING id`,
    [name, JSON.stringify(limits)],
  );
  return rows[0]!.id;
}

async function seedAgent(name: string, roleId: string): Promise<void> {
  await db.pool.query("INSERT INTO agents (name, role_id) VALUES ($1, $2)", [name, roleId]);
}

async function seedSkill(ref: string, fn: LocalSkillFn): Promise<void> {
  const [name, version] = ref.split("@");
  await db.pool.query(
    `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
     VALUES ($1, $2, '{}', '{}', '{"type":"local"}', 'low') ON CONFLICT DO NOTHING`,
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

async function waitForRunStatus(
  runId: string,
  statuses: string[],
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.pool.query<{ status: string }>(
      "SELECT status FROM flow_runs WHERE id = $1",
      [runId],
    );
    const status = rows[0]!.status;
    if (statuses.includes(status)) return status;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for run ${runId} to reach ${statuses}; at "${status}"`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runEvents(
  runId: string,
): Promise<Array<{ event_type: string; payload: Record<string, unknown> }>> {
  const { rows } = await db.pool.query(
    "SELECT event_type, payload FROM audit_events WHERE run_id = $1 ORDER BY seq",
    [runId],
  );
  return rows;
}

async function publishAndRun(
  definition: Record<string, unknown>,
  runInput: Record<string, unknown> = {},
): Promise<string> {
  const { flowVersionId } = await publishFlowVersion(db.pool, { definition, actor: USER });
  return startRun(ctx, { flowVersionId, triggeredBy: USER, runInput });
}

describe("per-skill invocation caps (scripted executor)", () => {
  it("blocks the (N+1)th invocation mid-run and fails the step and run", async () => {
    const roleId = await seedRole("cap-role", {
      skills: { "capped@1": { maxInvocationsPerRun: 2 } },
    });
    await seedAgent("cap-agent", roleId);
    let calls = 0;
    await seedSkill("capped@1", async (i) => {
      calls += 1;
      return i;
    });
    await grant("cap-agent", "capped@1");

    const runId = await publishAndRun({
      name: "cap-flow",
      steps: [
        { key: "s", agent: "cap-agent", skills: ["capped@1", "capped@1", "capped@1"] },
      ],
    });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("failed");

    // The third invocation was blocked BEFORE the skill executed.
    expect(calls).toBe(2);
    const events = await runEvents(runId);
    expect(events.filter((e) => e.event_type === "skill.invoked")).toHaveLength(2);
    const violation = events.find((e) => e.event_type === "enforcement.limit_violation");
    expect(violation!.payload).toMatchObject({ code: "limit_invocations", skillRef: "capped@1" });
    const run = await db.pool.query("SELECT failure_reason FROM flow_runs WHERE id = $1", [
      runId,
    ]);
    expect(run.rows[0].failure_reason).toContain("invocation limit");
  });

  it("counts per RUN: a fresh run under the cap completes", async () => {
    const runId = await publishAndRun({
      name: "cap-ok-flow",
      steps: [{ key: "s", agent: "cap-agent", skills: ["capped@1", "capped@1"] }],
    });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });

  it("counts failed attempts too — errors are not free retries", async () => {
    const roleId = await seedRole("flaky-cap-role", {
      skills: { "flaky-capped@1": { maxInvocationsPerRun: 2 } },
    });
    await seedAgent("flaky-cap-agent", roleId);
    await seedSkill("flaky-capped@1", async () => {
      throw new Error("boom");
    });
    await grant("flaky-cap-agent", "flaky-capped@1");

    const runId = await publishAndRun({
      name: "flaky-cap-flow",
      steps: [
        {
          key: "s",
          agent: "flaky-cap-agent",
          skills: ["flaky-capped@1"],
          retries: { max_attempts: 3, backoff: "none" },
        },
      ],
    });
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");

    const events = await runEvents(runId);
    // Two audited failed attempts, then the third is denied by the cap.
    const invoked = events.filter((e) => e.event_type === "skill.invoked");
    expect(invoked).toHaveLength(2);
    expect(invoked[0]!.payload).toMatchObject({ error: "boom" });
    expect(
      events.find((e) => e.event_type === "enforcement.limit_violation")!.payload,
    ).toMatchObject({ code: "limit_invocations" });
  });
});

describe("amount limits — FAIL CLOSED", () => {
  let payAgentReady = false;
  async function ensurePayAgent(): Promise<void> {
    if (payAgentReady) return;
    const roleId = await seedRole("pay-role", {
      skills: { "pay@1": { maxAmountPerInvocation: 1000 } },
    });
    await seedAgent("pay-agent", roleId);
    await seedSkill("pay@1", async (i) => ({ ...i, paid: true }));
    await grant("pay-agent", "pay@1");
    await publishFlowVersion(db.pool, {
      actor: USER,
      definition: { name: "pay-flow", steps: [{ key: "s", agent: "pay-agent", skills: ["pay@1"] }] },
    });
    payAgentReady = true;
  }
  async function runPay(runInput: Record<string, unknown>): Promise<string> {
    await ensurePayAgent();
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT fv.id FROM flow_versions fv JOIN flows f ON f.id = fv.flow_id
        WHERE f.name = 'pay-flow' ORDER BY fv.version DESC LIMIT 1`,
    );
    return startRun(ctx, { flowVersionId: rows[0]!.id, triggeredBy: USER, runInput });
  }

  it("allows amounts within the ceiling", async () => {
    const runId = await runPay({ amount: 250 });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });

  it("blocks amounts above the ceiling", async () => {
    const runId = await runPay({ amount: 250_000 });
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    expect(
      (await runEvents(runId)).find((e) => e.event_type === "enforcement.limit_violation")!
        .payload,
    ).toMatchObject({ code: "limit_amount" });
  });

  it("blocks when the amount field is MISSING — fail closed, the audit-grade proof", async () => {
    const runId = await runPay({ note: "no amount field at all" });
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    expect(
      (await runEvents(runId)).find((e) => e.event_type === "enforcement.limit_violation")!
        .payload,
    ).toMatchObject({ code: "limit_amount_unreadable" });
  });

  it("blocks when the amount is non-numeric — fail closed", async () => {
    const runId = await runPay({ amount: "one MILLION dollars" });
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    expect(
      (await runEvents(runId)).find((e) => e.event_type === "enforcement.limit_violation")!
        .payload,
    ).toMatchObject({ code: "limit_amount_unreadable" });
  });

  it("honours a custom amountField, and the WRONG field name still fails closed", async () => {
    const roleId = await seedRole("wire-role", {
      skills: { "wire@1": { maxAmountPerInvocation: 500, amountField: "notional" } },
    });
    await seedAgent("wire-agent", roleId);
    await seedSkill("wire@1", async (i) => i);
    await grant("wire-agent", "wire@1");
    await publishFlowVersion(db.pool, {
      actor: USER,
      definition: {
        name: "wire-flow",
        steps: [{ key: "s", agent: "wire-agent", skills: ["wire@1"] }],
      },
    });
    const fv = await db.pool.query<{ id: string }>(
      `SELECT fv.id FROM flow_versions fv JOIN flows f ON f.id = fv.flow_id
        WHERE f.name = 'wire-flow' ORDER BY fv.version DESC LIMIT 1`,
    );

    const okRun = await startRun(ctx, {
      flowVersionId: fv.rows[0]!.id,
      triggeredBy: USER,
      runInput: { notional: 100 },
    });
    expect(await waitForRunStatus(okRun, ["completed", "failed"])).toBe("completed");

    // "amount" is set but the configured field is "notional" → unreadable → deny.
    const badRun = await startRun(ctx, {
      flowVersionId: fv.rows[0]!.id,
      triggeredBy: USER,
      runInput: { amount: 100 },
    });
    expect(await waitForRunStatus(badRun, ["failed"])).toBe("failed");
    expect(
      (await runEvents(badRun)).find((e) => e.event_type === "enforcement.limit_violation")!
        .payload,
    ).toMatchObject({ code: "limit_amount_unreadable" });
  });
});

describe("run-level budgets and config hygiene", () => {
  it("enforces run.maxSkillInvocations across steps", async () => {
    const roleId = await seedRole("run-budget-role", { run: { maxSkillInvocations: 3 } });
    await seedAgent("run-budget-agent", roleId);
    await seedSkill("cheap@1", async (i) => i);
    await grant("run-budget-agent", "cheap@1");

    const runId = await publishAndRun({
      name: "run-budget-flow",
      steps: [
        { key: "a", agent: "run-budget-agent", skills: ["cheap@1", "cheap@1"] },
        { key: "b", agent: "run-budget-agent", skills: ["cheap@1", "cheap@1"] },
      ],
    });
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    const events = await runEvents(runId);
    expect(events.filter((e) => e.event_type === "skill.invoked")).toHaveLength(3);
    expect(
      events.find((e) => e.event_type === "enforcement.limit_violation")!.payload,
    ).toMatchObject({ code: "limit_run_invocations" });
  });

  it("an unreadable limit value denies everything it governs (fail closed)", async () => {
    const roleId = await seedRole("garbage-role", {
      skills: { "odd@1": { maxInvocationsPerRun: "three" } },
    });
    await seedAgent("garbage-agent", roleId);
    await seedSkill("odd@1", async (i) => i);
    await grant("garbage-agent", "odd@1");

    const runId = await publishAndRun({
      name: "garbage-flow",
      steps: [{ key: "s", agent: "garbage-agent", skills: ["odd@1"] }],
    });
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    const violation = (await runEvents(runId)).find(
      (e) => e.event_type === "enforcement.limit_violation",
    );
    expect(violation!.payload.reason).toContain("unreadable");
  });

  it("roles without limits behave exactly as before", async () => {
    const roleId = await seedRole("free-role", {});
    await seedAgent("free-agent", roleId);
    await seedSkill("free@1", async (i) => i);
    await grant("free-agent", "free@1");

    const runId = await publishAndRun(
      {
        name: "free-flow",
        steps: [{ key: "s", agent: "free-agent", skills: ["free@1", "free@1"] }],
      },
      { amount: "not even numeric, and nobody cares" },
    );
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
    expect(
      (await runEvents(runId)).some((e) => e.event_type === "enforcement.limit_violation"),
    ).toBe(false);
  });

  it("checkTokenBudget accounts for a caller-supplied next estimate", async () => {
    const roleId = await seedRole("estimate-role", { run: { maxTokens: 100 } });
    await expect(
      checkTokenBudget(db.pool, {
        runId: "99999999-9999-9999-9999-999999999999",
        roleId,
        nextEstimate: 150,
      }),
    ).rejects.toThrow(/token budget/);
    await expect(
      checkTokenBudget(db.pool, {
        runId: "99999999-9999-9999-9999-999999999999",
        roleId,
        nextEstimate: 50,
      }),
    ).resolves.toBeUndefined();
  });

  it("an unknown role fails closed instead of silently allowing", async () => {
    await expect(
      checkSkillLimit(db.pool, {
        runId: "99999999-9999-9999-9999-999999999999",
        roleId: "00000000-0000-0000-0000-000000000000",
        skillRef: "anything@1",
        input: {},
      }),
    ).rejects.toThrow(/not found.*failing closed/);
  });

  it("an unreadable token budget config denies the call", async () => {
    const roleId = await seedRole("bad-tokens-role", { run: { maxTokens: "lots" } });
    await expect(
      checkTokenBudget(db.pool, { runId: "99999999-9999-9999-9999-999999999999", roleId }),
    ).rejects.toThrow(/unreadable/);
  });
});

// ----------------------------------------------------------------- LLM path

/** Scripted provider: returns queued turns in order and records every request. */
class MockProvider implements LLMProvider {
  requests: LLMRequest[] = [];
  private turns: LLMTurn[] = [];

  queue(...turns: LLMTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  async complete(req: LLMRequest): Promise<LLMTurn> {
    this.requests.push(req);
    const turn = this.turns.shift();
    if (!turn) throw new Error("MockProvider queue exhausted");
    return turn;
  }
}

const textTurn = (t: string): LLMTurn => ({
  stopReason: "end_turn",
  content: [{ type: "text", text: t }],
  usage: { inputTokens: 100, outputTokens: 20 },
});

const toolTurn = (name: string, input: Record<string, unknown>, ids: string[]): LLMTurn => ({
  stopReason: "tool_use",
  content: ids.map((id) => ({ type: "tool_use" as const, id, name, input })),
  usage: { inputTokens: 150, outputTokens: 30 },
});

function llmExecutor(provider: LLMProvider): LLMExecutor {
  return new LLMExecutor({
    pool: db.pool,
    providers: { anthropic: provider },
    invoker: new SkillInvoker(db.pool, registry),
  });
}

function llmReq(skills: string[], runId: string, roleId: string) {
  return {
    step: { key: "work", agent: "llm-agent", skills, instructions: "Work." },
    input: {},
    signal: new AbortController().signal,
    meta: {
      runId,
      stepRunId: "55555555-5555-5555-5555-555555555555",
      agentId: "66666666-6666-6666-6666-666666666666",
      agentName: "llm-agent",
      roleId,
      modelConfig: { provider: "anthropic", model: "claude-opus-4-8" },
    },
  };
}

describe("token budgets and skill caps in the LLM executor", () => {
  it("an exhausted token budget fails BEFORE the provider is called again", async () => {
    const runId = "20000000-0000-0000-0000-000000000001";
    const roleId = await seedRole("tok-role", { run: { maxTokens: 100 } });
    await seedSkill("tok-skill@1", async () => ({ ok: true }));

    const provider = new MockProvider().queue(
      toolTurn(toolNameForRef("tok-skill@1"), {}, ["call_1"]), // 180 tokens, over budget
      textTurn("should never be requested"),
    );
    await expect(
      llmExecutor(provider).execute(llmReq(["tok-skill@1"], runId, roleId)),
    ).rejects.toThrow(/token budget/);

    // Exactly one provider call: the second was denied before it was made.
    expect(provider.requests).toHaveLength(1);
    const events = await runEvents(runId);
    expect(events.map((e) => e.event_type)).toEqual([
      "llm.call",
      "skill.invoked",
      "enforcement.limit_violation",
    ]);
    expect(events.at(-1)!.payload).toMatchObject({ code: "limit_tokens" });
  });

  it("a skill cap violation throws out of execute() and is never fed back to the model", async () => {
    const runId = "20000000-0000-0000-0000-000000000002";
    const roleId = await seedRole("llm-cap-role", {
      skills: { "llm-capped@1": { maxInvocationsPerRun: 1 } },
    });
    let calls = 0;
    await seedSkill("llm-capped@1", async () => {
      calls += 1;
      return { ok: true };
    });

    const provider = new MockProvider().queue(
      toolTurn(toolNameForRef("llm-capped@1"), {}, ["call_1", "call_2"]),
      textTurn("should never be requested"),
    );
    await expect(
      llmExecutor(provider).execute(llmReq(["llm-capped@1"], runId, roleId)),
    ).rejects.toThrow(/invocation limit/);

    expect(calls).toBe(1); // second call blocked before execution
    expect(provider.requests).toHaveLength(1); // the model never saw the violation
    const events = await runEvents(runId);
    expect(events.filter((e) => e.event_type === "skill.invoked")).toHaveLength(1);
    expect(
      events.find((e) => e.event_type === "enforcement.limit_violation")!.payload,
    ).toMatchObject({ code: "limit_invocations" });
  });

  it("non-limit failures inside the limit check propagate without a violation event", async () => {
    const runId = "20000000-0000-0000-0000-000000000003";
    await seedSkill("ghost-role-skill@1", async () => ({}));
    const provider = new MockProvider().queue(textTurn("unreachable"));
    await expect(
      llmExecutor(provider).execute(
        llmReq(["ghost-role-skill@1"], runId, "00000000-0000-0000-0000-000000000000"),
      ),
    ).rejects.toThrow(/not found/);
    expect(
      (await runEvents(runId)).some((e) => e.event_type === "enforcement.limit_violation"),
    ).toBe(false);
  });
});

describe("proxy sessions honour per-skill limits", () => {
  const ACTOR = { type: "user" as const, name: "proxy-tester" };
  let sessionId: string;

  beforeAll(async () => {
    const roleId = await seedRole("px-lim-role", {
      skills: {
        "px-capped@1": { maxInvocationsPerRun: 2 },
        "px-pay@1": { maxInvocationsPerRun: 2, maxAmountPerInvocation: 100 },
      },
    });
    await seedAgent("px-lim-agent", roleId);
    for (const ref of ["px-capped@1", "px-pay@1"]) {
      await seedSkill(ref, async (i) => i);
      await grant("px-lim-agent", ref);
    }
    const session = await openSession(db.pool, { label: "limits-session", actor: ACTOR });
    sessionId = session.id;
  });

  function check(skillRef: string, input?: Record<string, unknown>) {
    return checkAndAuthorize(db.pool, {
      sessionId,
      agentName: "px-lim-agent",
      skillRef,
      actor: ACTOR,
      ...(input !== undefined ? { input } : {}),
    });
  }

  it("caps invocations within the session and audits the violation", async () => {
    expect((await check("px-capped@1", {})).allowed).toBe(true);
    expect((await check("px-capped@1", {})).allowed).toBe(true);
    const third = await check("px-capped@1", {});
    expect(third).toMatchObject({ allowed: false, code: "limit_invocations" });

    const { rows } = await db.pool.query(
      `SELECT payload FROM audit_events
        WHERE event_type = 'enforcement.limit_violation'
          AND entity_type = 'proxy_session' AND entity_id = $1`,
      [sessionId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].payload).toMatchObject({ via: "proxy", code: "limit_invocations" });
  });

  it("amounts fail closed in the proxy too, and denials never consume the cap", async () => {
    expect(await check("px-pay@1", { amount: 50 })).toMatchObject({ allowed: true }); // 1 of 2
    expect(await check("px-pay@1", { amount: 5000 })).toMatchObject({
      allowed: false,
      code: "limit_amount",
    });
    // No input at all → the amount is unreadable → deny (fail closed).
    expect(await check("px-pay@1")).toMatchObject({
      allowed: false,
      code: "limit_amount_unreadable",
    });
    // The two denials did not act, so the second allowed slot is still free…
    expect(await check("px-pay@1", { amount: 60 })).toMatchObject({ allowed: true }); // 2 of 2
    // …and now the cap is genuinely exhausted.
    expect(await check("px-pay@1", { amount: 70 })).toMatchObject({
      allowed: false,
      code: "limit_invocations",
    });
  });
});

describe("proxy sessions honour per-skill argument grant policy (allowlist / pathScope)", () => {
  const ACTOR = { type: "user" as const, name: "argpolicy-tester" };
  let sessionId: string;

  beforeAll(async () => {
    const roleId = await seedRole("px-arg-role", {
      skills: {
        // destination allowlist on a wire/transfer-style skill
        "px-allow@1": {
          maxInvocationsPerRun: 5,
          allowlist: { field: "destination", values: ["acct-approved-1", "acct-approved-2"] },
        },
        // path scope on a file-touching skill
        "px-scope@1": {
          maxInvocationsPerRun: 5,
          pathScope: { field: "path", prefix: "/srv/project" },
        },
      },
    });
    await seedAgent("px-arg-agent", roleId);
    for (const ref of ["px-allow@1", "px-scope@1"]) {
      await seedSkill(ref, async (i) => i);
      await grant("px-arg-agent", ref);
    }
    const session = await openSession(db.pool, { label: "argpolicy-session", actor: ACTOR });
    sessionId = session.id;
  });

  function check(skillRef: string, input?: Record<string, unknown>) {
    return checkAndAuthorize(db.pool, {
      sessionId,
      agentName: "px-arg-agent",
      skillRef,
      actor: ACTOR,
      ...(input !== undefined ? { input } : {}),
    });
  }

  async function lastLimitViolation(): Promise<Record<string, unknown> | undefined> {
    const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events
        WHERE event_type = 'enforcement.limit_violation'
          AND entity_type = 'proxy_session' AND entity_id = $1
        ORDER BY seq DESC LIMIT 1`,
      [sessionId],
    );
    return rows[0]?.payload;
  }

  it("allowlist: an on-list destination is allowed, an off-list one is denied and audited", async () => {
    expect(await check("px-allow@1", { destination: "acct-approved-1" })).toMatchObject({
      allowed: true,
    });

    const off = await check("px-allow@1", { destination: "acct-attacker" });
    expect(off).toMatchObject({ allowed: false, code: "limit_allowlist" });
    expect(await lastLimitViolation()).toMatchObject({
      via: "proxy",
      code: "limit_allowlist",
      skillRef: "px-allow@1",
    });
  });

  it("allowlist: a missing / non-string field fails closed as unreadable", async () => {
    // No input at all → field missing → unreadable.
    expect(await check("px-allow@1")).toMatchObject({
      allowed: false,
      code: "limit_allowlist_unreadable",
    });
    // Field present but not a string → unreadable.
    expect(await check("px-allow@1", { destination: 12345 })).toMatchObject({
      allowed: false,
      code: "limit_allowlist_unreadable",
    });
  });

  it("pathScope: in-prefix allowed; out-of-prefix and traversal denied; missing fails closed", async () => {
    // In-prefix path is allowed.
    expect(await check("px-scope@1", { path: "/srv/project/reports/q1.csv" })).toMatchObject({
      allowed: true,
    });

    // Outside the prefix → limit_path.
    const outside = await check("px-scope@1", { path: "/etc/passwd" });
    expect(outside).toMatchObject({ allowed: false, code: "limit_path" });
    expect(await lastLimitViolation()).toMatchObject({
      via: "proxy",
      code: "limit_path",
      skillRef: "px-scope@1",
    });

    // Traversal that escapes the prefix → limit_path.
    expect(
      await check("px-scope@1", { path: "/srv/project/../../etc/shadow" }),
    ).toMatchObject({ allowed: false, code: "limit_path" });

    // Missing / empty / non-string path → unreadable (fail closed).
    expect(await check("px-scope@1")).toMatchObject({
      allowed: false,
      code: "limit_path_unreadable",
    });
    expect(await check("px-scope@1", { path: "" })).toMatchObject({
      allowed: false,
      code: "limit_path_unreadable",
    });
    expect(await check("px-scope@1", { path: 999 })).toMatchObject({
      allowed: false,
      code: "limit_path_unreadable",
    });
  });

  it("an argument-policy denial does NOT consume the per-skill invocation slot", async () => {
    // Fresh role/agent/session so the invocation count starts at zero.
    const roleId = await seedRole("px-arg-cap-role", {
      skills: {
        "px-arg-cap@1": {
          maxInvocationsPerRun: 1,
          allowlist: { field: "destination", values: ["ok-dest"] },
        },
      },
    });
    await seedAgent("px-arg-cap-agent", roleId);
    await seedSkill("px-arg-cap@1", async (i) => i);
    await grant("px-arg-cap-agent", "px-arg-cap@1");
    const session = await openSession(db.pool, { label: "argpolicy-cap-session", actor: ACTOR });

    const capCheck = (input?: Record<string, unknown>) =>
      checkAndAuthorize(db.pool, {
        sessionId: session.id,
        agentName: "px-arg-cap-agent",
        skillRef: "px-arg-cap@1",
        actor: ACTOR,
        ...(input !== undefined ? { input } : {}),
      });

    // An off-list denial must not burn the only allowed slot…
    expect(await capCheck({ destination: "attacker" })).toMatchObject({
      allowed: false,
      code: "limit_allowlist",
    });
    // …so the single permitted invocation is still available.
    expect(await capCheck({ destination: "ok-dest" })).toMatchObject({ allowed: true });
    // …and only now is the cap genuinely exhausted.
    expect(await capCheck({ destination: "ok-dest" })).toMatchObject({
      allowed: false,
      code: "limit_invocations",
    });
  });

  it("DEFENSIVE: a non-LimitViolationError from a malformed limits row rolls back, never allows", async () => {
    // Write an invalid shape directly to roles.limits, bypassing the admin write
    // schema: allowlist.values is a number (no `.includes` method), so
    // assertSkillLimits throws a TypeError, a non-LimitViolationError (a string
    // would still have `.includes` and fail closed as limit_allowlist instead).
    // The proxy must let the TypeError propagate (rollback), NOT swallow it.
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO roles (name, limits) VALUES ($1, $2) RETURNING id`,
      [
        "px-arg-malformed-role",
        JSON.stringify({
          skills: { "px-arg-bad@1": { allowlist: { field: "destination", values: 123 } } },
        }),
      ],
    );
    const roleId = rows[0]!.id;
    await seedAgent("px-arg-bad-agent", roleId);
    await seedSkill("px-arg-bad@1", async (i) => i);
    await grant("px-arg-bad-agent", "px-arg-bad@1");
    const session = await openSession(db.pool, { label: "argpolicy-bad-session", actor: ACTOR });

    await expect(
      checkAndAuthorize(db.pool, {
        sessionId: session.id,
        agentName: "px-arg-bad-agent",
        skillRef: "px-arg-bad@1",
        actor: ACTOR,
        input: { destination: "anything" },
      }),
    ).rejects.toThrow();

    // The transaction rolled back: no 'allowed' proxy_actions row was persisted,
    // so a thrown non-limit error never leaks through as an authorization.
    const allowed = await db.pool.query(
      `SELECT 1 FROM proxy_actions
        WHERE session_id = $1 AND skill_ref = 'px-arg-bad@1' AND decision = 'allowed'`,
      [session.id],
    );
    expect(allowed.rows).toHaveLength(0);
  });
});

// ------------------------------------------------------------ windowed quotas

/**
 * Windowed quotas accrue across a skill's ALLOWED proxy invocations within a
 * time/session window that spans runs, denying fail-closed when the running
 * total plus this call's contribution would exceed the ceiling. Every
 * guarantee is attacked: the ceiling itself, denied attempts NEVER accruing,
 * a count quota with no field, and cross-session accrual within one window.
 */
describe("proxy sessions enforce windowed quotas (accrual across sessions/runs)", () => {
  const ACTOR = { type: "user" as const, name: "quota-tester" };

  async function quotaUsageRows(agentName: string, quotaKey: string): Promise<number> {
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM quota_usage q
         JOIN agents a ON a.id = q.agent_id
        WHERE a.name = $1 AND q.quota_key = $2`,
      [agentName, quotaKey],
    );
    return rows[0]!.n;
  }

  it("a monthly amount quota denies once the running total would exceed max, and DENIED attempts never accrue", async () => {
    // {field:"amount", window:"month", max:1000}: the canonical "spend cap" as a
    // generic windowed quota. 300+300+300 (=900) all allowed; the next 300 would
    // make 1200 > 1000 and is DENIED. A denied 5000 must NOT raise the total, so
    // a later legitimate 100 (900+100=1000, inclusive) is still allowed.
    const roleId = await seedRole("px-quota-amt-role", {
      skills: {
        "px-quota-amt@1": {
          quotas: [{ key: "monthly_amount", field: "amount", window: "month", max: 1000 }],
        },
      },
    });
    await seedAgent("px-quota-amt-agent", roleId);
    await seedSkill("px-quota-amt@1", async (i) => i);
    await grant("px-quota-amt-agent", "px-quota-amt@1");
    const session = await openSession(db.pool, { label: "quota-amt-session", actor: ACTOR });

    const check = (amount: number) =>
      checkAndAuthorize(db.pool, {
        sessionId: session.id,
        agentName: "px-quota-amt-agent",
        skillRef: "px-quota-amt@1",
        actor: ACTOR,
        input: { amount },
      });

    expect(await check(300)).toMatchObject({ allowed: true }); // running 300
    expect(await check(300)).toMatchObject({ allowed: true }); // running 600
    expect(await check(300)).toMatchObject({ allowed: true }); // running 900

    // 900 + 300 = 1200 > 1000 → DENIED.
    expect(await check(300)).toMatchObject({ allowed: false, code: "limit_quota" });
    // A huge denied attempt must not accrue toward the total.
    expect(await check(5000)).toMatchObject({ allowed: false, code: "limit_quota" });

    // The two denials accrued NOTHING: the total is still 900, so 900+100=1000
    // (inclusive boundary) is allowed.
    expect(await check(100)).toMatchObject({ allowed: true }); // running 1000
    // …and now genuinely exhausted: 1000 + 1 = 1001 > 1000.
    expect(await check(1)).toMatchObject({ allowed: false, code: "limit_quota" });

    // Exactly four ALLOWED actions wrote a quota_usage row; no denial did.
    expect(await quotaUsageRows("px-quota-amt-agent", "monthly_amount")).toBe(4);
    const { rows } = await db.pool.query<{ used: string }>(
      `SELECT coalesce(sum(q.amount),0) AS used FROM quota_usage q
         JOIN agents a ON a.id = q.agent_id
        WHERE a.name = 'px-quota-amt-agent' AND q.quota_key = 'monthly_amount'`,
    );
    expect(Number(rows[0]!.used)).toBe(1000);

    // The denials were audited as limit violations via the proxy.
    const viol = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events
        WHERE event_type = 'enforcement.limit_violation'
          AND entity_type = 'proxy_session' AND entity_id = $1
        ORDER BY seq DESC LIMIT 1`,
      [session.id],
    );
    expect(viol.rows[0]!.payload).toMatchObject({ via: "proxy", code: "limit_quota" });
  });

  it("an unreadable / negative quota input fails closed and does not accrue", async () => {
    const roleId = await seedRole("px-quota-failclosed-role", {
      skills: {
        "px-quota-fc@1": {
          quotas: [{ key: "fc_amount", field: "amount", window: "lifetime", max: 1000 }],
        },
      },
    });
    await seedAgent("px-quota-fc-agent", roleId);
    await seedSkill("px-quota-fc@1", async (i) => i);
    await grant("px-quota-fc-agent", "px-quota-fc@1");
    const session = await openSession(db.pool, { label: "quota-fc-session", actor: ACTOR });

    const check = (input?: Record<string, unknown>) =>
      checkAndAuthorize(db.pool, {
        sessionId: session.id,
        agentName: "px-quota-fc-agent",
        skillRef: "px-quota-fc@1",
        actor: ACTOR,
        ...(input !== undefined ? { input } : {}),
      });

    // Missing field → unreadable (fail closed).
    expect(await check()).toMatchObject({ allowed: false, code: "limit_quota_unreadable" });
    expect(await check({ note: "no amount" })).toMatchObject({
      allowed: false,
      code: "limit_quota_unreadable",
    });
    // Non-numeric → unreadable.
    expect(await check({ amount: "1000" })).toMatchObject({
      allowed: false,
      code: "limit_quota_unreadable",
    });
    // Negative → denied (cannot count DOWN a running total).
    expect(await check({ amount: -1_000_000 })).toMatchObject({
      allowed: false,
      code: "limit_quota",
    });

    // None of the fail-closed denials accrued anything.
    expect(await quotaUsageRows("px-quota-fc-agent", "fc_amount")).toBe(0);
    // A legitimate call still works and accrues exactly one row.
    expect(await check({ amount: 250 })).toMatchObject({ allowed: true });
    expect(await quotaUsageRows("px-quota-fc-agent", "fc_amount")).toBe(1);
  });

  it("a pure-count quota (no field) per day denies the 3rd call", async () => {
    // {window:"day", max:2} with no field: each allowed call contributes 1.
    const roleId = await seedRole("px-quota-count-role", {
      skills: {
        "px-quota-count@1": { quotas: [{ key: "daily_calls", window: "day", max: 2 }] },
      },
    });
    await seedAgent("px-quota-count-agent", roleId);
    await seedSkill("px-quota-count@1", async (i) => i);
    await grant("px-quota-count-agent", "px-quota-count@1");
    const session = await openSession(db.pool, { label: "quota-count-session", actor: ACTOR });

    const check = () =>
      checkAndAuthorize(db.pool, {
        sessionId: session.id,
        agentName: "px-quota-count-agent",
        skillRef: "px-quota-count@1",
        actor: ACTOR,
        input: {}, // no field needed — a count quota ignores input
      });

    expect(await check()).toMatchObject({ allowed: true }); // 1 of 2
    expect(await check()).toMatchObject({ allowed: true }); // 2 of 2
    expect(await check()).toMatchObject({ allowed: false, code: "limit_quota" }); // 3rd denied

    // Exactly two allowed rows, each amount 1 → total 2.
    expect(await quotaUsageRows("px-quota-count-agent", "daily_calls")).toBe(2);
  });

  it("accrues ACROSS sessions within the same window (two sessions, same agent, sum together)", async () => {
    // The month window spans sessions: the same agent's two sessions share one
    // running total. max=1000; session A spends 600, session B then spends 500
    // → 600+500=1100 > 1000 and B's 500 is denied; a 400 in B (600+400=1000) is
    // allowed. Proves the SUM is NOT scoped to a single session for a month window.
    const roleId = await seedRole("px-quota-xsess-role", {
      skills: {
        "px-quota-xsess@1": {
          quotas: [{ key: "xsess_amount", field: "amount", window: "month", max: 1000 }],
        },
      },
    });
    await seedAgent("px-quota-xsess-agent", roleId);
    await seedSkill("px-quota-xsess@1", async (i) => i);
    await grant("px-quota-xsess-agent", "px-quota-xsess@1");

    const sessionA = await openSession(db.pool, { label: "quota-xsessA", actor: ACTOR });
    const sessionB = await openSession(db.pool, { label: "quota-xsessB", actor: ACTOR });
    const check = (sessionId: string, amount: number) =>
      checkAndAuthorize(db.pool, {
        sessionId,
        agentName: "px-quota-xsess-agent",
        skillRef: "px-quota-xsess@1",
        actor: ACTOR,
        input: { amount },
      });

    expect(await check(sessionA.id, 600)).toMatchObject({ allowed: true }); // running 600
    // Session B sees session A's accrual: 600 + 500 = 1100 > 1000 → denied.
    expect(await check(sessionB.id, 500)).toMatchObject({ allowed: false, code: "limit_quota" });
    // 600 + 400 = 1000 (inclusive) → allowed in session B.
    expect(await check(sessionB.id, 400)).toMatchObject({ allowed: true }); // running 1000
    // Exhausted across both sessions.
    expect(await check(sessionA.id, 1)).toMatchObject({ allowed: false, code: "limit_quota" });

    // Two allowed rows total (one per session), summing to 1000.
    const { rows } = await db.pool.query<{ n: number; used: string }>(
      `SELECT count(*)::int AS n, coalesce(sum(q.amount),0) AS used FROM quota_usage q
         JOIN agents a ON a.id = q.agent_id
        WHERE a.name = 'px-quota-xsess-agent' AND q.quota_key = 'xsess_amount'`,
    );
    expect(rows[0]!.n).toBe(2);
    expect(Number(rows[0]!.used)).toBe(1000);
  });

  it("a SESSION-window quota does NOT bleed across sessions (the per-session counterpart)", async () => {
    // Counterpart to the cross-session test: window:"session" scopes the SUM to
    // session_id, so a second session starts fresh. max=2 rows/session.
    const roleId = await seedRole("px-quota-sessonly-role", {
      skills: {
        "px-quota-sessonly@1": {
          quotas: [{ key: "per_session", window: "session", max: 2 }],
        },
      },
    });
    await seedAgent("px-quota-sessonly-agent", roleId);
    await seedSkill("px-quota-sessonly@1", async (i) => i);
    await grant("px-quota-sessonly-agent", "px-quota-sessonly@1");

    const sessionA = await openSession(db.pool, { label: "quota-sessonlyA", actor: ACTOR });
    const sessionB = await openSession(db.pool, { label: "quota-sessonlyB", actor: ACTOR });
    const check = (sessionId: string) =>
      checkAndAuthorize(db.pool, {
        sessionId,
        agentName: "px-quota-sessonly-agent",
        skillRef: "px-quota-sessonly@1",
        actor: ACTOR,
        input: {},
      });

    expect(await check(sessionA.id)).toMatchObject({ allowed: true }); // A: 1 of 2
    expect(await check(sessionA.id)).toMatchObject({ allowed: true }); // A: 2 of 2
    expect(await check(sessionA.id)).toMatchObject({ allowed: false, code: "limit_quota" }); // A exhausted
    // Session B starts at zero — the session window does not see A's accrual.
    expect(await check(sessionB.id)).toMatchObject({ allowed: true }); // B: 1 of 2
    expect(await check(sessionB.id)).toMatchObject({ allowed: true }); // B: 2 of 2
    expect(await check(sessionB.id)).toMatchObject({ allowed: false, code: "limit_quota" }); // B exhausted
  });

  it("a quota denial does NOT consume a co-configured per-skill invocation slot", async () => {
    // A quota over its ceiling must deny WITHOUT burning the invocation cap (the
    // denial returns before any proxy_actions row is written, exactly like the
    // amount/allowlist denials). max invocations 2; quota count max 1.
    const roleId = await seedRole("px-quota-combo-role", {
      skills: {
        "px-quota-combo@1": {
          maxInvocationsPerRun: 2,
          quotas: [{ key: "combo_calls", window: "lifetime", max: 1 }],
        },
      },
    });
    await seedAgent("px-quota-combo-agent", roleId);
    await seedSkill("px-quota-combo@1", async (i) => i);
    await grant("px-quota-combo-agent", "px-quota-combo@1");
    const session = await openSession(db.pool, { label: "quota-combo-session", actor: ACTOR });
    const check = () =>
      checkAndAuthorize(db.pool, {
        sessionId: session.id,
        agentName: "px-quota-combo-agent",
        skillRef: "px-quota-combo@1",
        actor: ACTOR,
        input: {},
      });

    expect(await check()).toMatchObject({ allowed: true }); // quota 1 of 1, invocation 1 of 2
    // Quota exhausted → denied by limit_quota, NOT limit_invocations.
    expect(await check()).toMatchObject({ allowed: false, code: "limit_quota" });
    // The denial did not consume an invocation slot or accrue a quota row.
    const actions = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM proxy_actions
        WHERE session_id = $1 AND skill_ref = 'px-quota-combo@1' AND decision = 'allowed'`,
      [session.id],
    );
    expect(actions.rows[0]!.n).toBe(1);
    expect(await quotaUsageRows("px-quota-combo-agent", "combo_calls")).toBe(1);
  });
});
