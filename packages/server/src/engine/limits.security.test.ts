import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import type { LocalSkillFn } from "./executor.js";
import { GraphileWorkerBackend } from "./graphile-backend.js";
import {
  assertQuota,
  assertSkillLimits,
  checkSkillLimit,
  checkTokenBudget,
  getEnforcedLimits,
  isPathWithinPrefix,
  LimitViolationError,
  normalizePath,
  quotaContribution,
  type Quota,
  type SkillLimitConfig,
} from "./limits.js";
import { publishFlowVersion } from "./flows.js";
import { createHandlers, startRun, type EngineContext } from "./orchestrator.js";
import { SkillInvoker } from "../skills/invoker.js";
import { SequentialInvokerExecutor } from "../skills/sequential-executor.js";

/**
 * Red-team regression suite for two confirmed enforcement defects (P0):
 *
 *  1. NEGATIVE-AMOUNT FAIL-OPEN — the amount ceiling only rejected `value >
 *     max`, so a large NEGATIVE amount slipped under the ceiling. A signed
 *     amount is never a benign value for an amount cap; it must be denied.
 *
 *  2. LIVE LIMITS FAIL-OPEN — role limits were read LIVE from roles.limits at
 *     invocation, so an admin raising a role's ceilings mid-run silently
 *     widened the enforcement of an already-scheduled run. Limits must be
 *     FROZEN at scheduling time (step_runs.limits_snapshot) and the checks must
 *     read the frozen copy, not the live row.
 *
 * Fail-closed everywhere: the existing missing / non-numeric / non-finite /
 * unknown-role cases must continue to deny.
 */

// ---------------------------------------------------------------- pure checks

describe("assertSkillLimits — negative-amount fail-open is closed", () => {
  const cfg: SkillLimitConfig = { maxAmountPerInvocation: 1000 };

  it("rejects a large negative amount that slips under the ceiling", () => {
    expect(() =>
      assertSkillLimits(cfg, 0, { amount: -1_000_000 }, "pay@1"),
    ).toThrow(LimitViolationError);
    try {
      assertSkillLimits(cfg, 0, { amount: -1_000_000 }, "pay@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect(err).toBeInstanceOf(LimitViolationError);
      expect((err as LimitViolationError).code).toBe("limit_amount");
      expect((err as LimitViolationError).message).toContain("negative");
    }
  });

  it("rejects a small negative amount (-0.01) — no signed value is benign", () => {
    expect(() => assertSkillLimits(cfg, 0, { amount: -0.01 }, "pay@1")).toThrowError(
      /negative/,
    );
  });

  it("rejects negative amounts through a custom amountField too", () => {
    const wire: SkillLimitConfig = { maxAmountPerInvocation: 500, amountField: "notional" };
    expect(() => assertSkillLimits(wire, 0, { notional: -999 }, "wire@1")).toThrowError(
      /negative/,
    );
  });

  it("still allows zero and positive amounts within the ceiling", () => {
    expect(() => assertSkillLimits(cfg, 0, { amount: 0 }, "pay@1")).not.toThrow();
    expect(() => assertSkillLimits(cfg, 0, { amount: 1000 }, "pay@1")).not.toThrow();
    expect(() => assertSkillLimits(cfg, 0, { amount: 999.99 }, "pay@1")).not.toThrow();
  });

  it("still blocks positive amounts over the ceiling (unchanged behaviour)", () => {
    try {
      assertSkillLimits(cfg, 0, { amount: 1001 }, "pay@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect((err as LimitViolationError).code).toBe("limit_amount");
      expect((err as LimitViolationError).message).toContain("exceeds");
    }
  });

  it("still FAILS CLOSED on a missing amount field", () => {
    try {
      assertSkillLimits(cfg, 0, { note: "no amount" }, "pay@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect((err as LimitViolationError).code).toBe("limit_amount_unreadable");
    }
  });

  it("still FAILS CLOSED on a non-numeric amount", () => {
    try {
      assertSkillLimits(cfg, 0, { amount: "-1000000" }, "pay@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      // A negative number disguised as a STRING is non-numeric → unreadable.
      expect((err as LimitViolationError).code).toBe("limit_amount_unreadable");
    }
  });

  it("still FAILS CLOSED on a non-finite amount (-Infinity / NaN)", () => {
    for (const bad of [Number.NEGATIVE_INFINITY, Number.NaN]) {
      try {
        assertSkillLimits(cfg, 0, { amount: bad }, "pay@1");
        throw new Error("expected a LimitViolationError");
      } catch (err) {
        expect((err as LimitViolationError).code).toBe("limit_amount_unreadable");
      }
    }
  });
});

// ----------------------------------------------------------- quotas (pure)

describe("quotaContribution — fail closed mirroring the amount guards", () => {
  it("returns 1 for a count quota (no field)", () => {
    const q: Quota = { key: "calls", max: 5, window: "day" };
    expect(quotaContribution(q, {}, "skill@1")).toBe(1);
    // A count quota ignores any input entirely — even a hostile one.
    expect(quotaContribution(q, { field: -999, amount: "junk" }, "skill@1")).toBe(1);
  });

  it("reads the named field for a quantity quota", () => {
    const q: Quota = { key: "amount", field: "amount", max: 1000, window: "month" };
    expect(quotaContribution(q, { amount: 250 }, "pay@1")).toBe(250);
    expect(quotaContribution(q, { amount: 0 }, "pay@1")).toBe(0);
    expect(quotaContribution(q, { amount: 999.99 }, "pay@1")).toBe(999.99);
  });

  it("FAILS CLOSED as limit_quota_unreadable on a missing field", () => {
    const q: Quota = { key: "amount", field: "amount", max: 1000, window: "month" };
    try {
      quotaContribution(q, { note: "no amount" }, "pay@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect(err).toBeInstanceOf(LimitViolationError);
      expect((err as LimitViolationError).code).toBe("limit_quota_unreadable");
    }
  });

  it("FAILS CLOSED as limit_quota_unreadable on a non-number / non-finite field", () => {
    const q: Quota = { key: "amount", field: "amount", max: 1000, window: "month" };
    // A number disguised as a string is non-numeric → unreadable, exactly like
    // the amount cap (never coerced into a value that could slip under a ceiling).
    for (const bad of ["250", null, true, ["250"], { v: 250 }, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        quotaContribution(q, { amount: bad }, "pay@1");
        throw new Error("expected a LimitViolationError");
      } catch (err) {
        expect((err as LimitViolationError).code).toBe("limit_quota_unreadable");
      }
    }
  });

  it("FAILS CLOSED as limit_quota on a negative field (cannot count DOWN a total)", () => {
    const q: Quota = { key: "amount", field: "amount", max: 1000, window: "month" };
    // A negative contribution would lower a running total and let a later call
    // slip under the ceiling — denied, mirroring the amount guard exactly.
    for (const bad of [-0.01, -1, -1_000_000]) {
      try {
        quotaContribution(q, { amount: bad }, "pay@1");
        throw new Error("expected a LimitViolationError");
      } catch (err) {
        expect((err as LimitViolationError).code).toBe("limit_quota");
        expect((err as LimitViolationError).message).toContain("negative");
      }
    }
  });
});

describe("assertQuota — inclusive ceiling at the boundary", () => {
  const q: Quota = { key: "amount", field: "amount", max: 1000, window: "month" };

  it("allows priorUsed + contribution exactly AT max (inclusive)", () => {
    expect(() => assertQuota(q, 700, 300, "pay@1")).not.toThrow();
    expect(() => assertQuota(q, 1000, 0, "pay@1")).not.toThrow();
    expect(() => assertQuota(q, 0, 1000, "pay@1")).not.toThrow();
  });

  it("denies one unit OVER max", () => {
    try {
      assertQuota(q, 700, 300.01, "pay@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect(err).toBeInstanceOf(LimitViolationError);
      expect((err as LimitViolationError).code).toBe("limit_quota");
      expect((err as LimitViolationError).message).toContain("amount");
    }
  });

  it("denies when the prior total ALONE already meets max and one more is added", () => {
    expect(() => assertQuota(q, 1000, 1, "pay@1")).toThrowError(LimitViolationError);
    expect(() => assertQuota(q, 1200, 0, "pay@1")).toThrowError(/exceed/);
  });

  it("a count quota (contribution 1) denies the call that would step over max", () => {
    const count: Quota = { key: "calls", max: 2, window: "day" };
    expect(() => assertQuota(count, 0, 1, "x@1")).not.toThrow(); // 1 of 2
    expect(() => assertQuota(count, 1, 1, "x@1")).not.toThrow(); // 2 of 2
    expect(() => assertQuota(count, 2, 1, "x@1")).toThrowError(/limit/); // 3rd denied
  });
});

// ------------------------------------------------------------- frozen limits

let db: TestDb;
let ctx: EngineContext;
const registry = new Map<string, LocalSkillFn>();
const USER = { type: "user" as const, id: "sec-user", name: "Security Tester" };

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

async function setLiveLimits(roleId: string, limits: Record<string, unknown>): Promise<void> {
  await db.pool.query("UPDATE roles SET limits = $2 WHERE id = $1", [
    roleId,
    JSON.stringify(limits),
  ]);
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

/**
 * A flow_run we never advance, used to attach a hand-frozen step_run to so
 * the limit helpers can be unit-tested in isolation. The flow needs ≥1 valid
 * step to publish; a bare approval gate needs no agent/skill setup.
 */
async function seedBareRun(flowName: string): Promise<string> {
  const { flowVersionId } = await publishFlowVersion(db.pool, {
    actor: USER,
    definition: {
      name: flowName,
      steps: [{ key: "noop", agent: "placeholder-agent", skills: ["placeholder@1"] }],
    },
  });
  const fr = await db.pool.query<{ id: string }>(
    `INSERT INTO flow_runs (flow_version_id, triggered_by, input) VALUES ($1, $2, '{}') RETURNING id`,
    [flowVersionId, JSON.stringify(USER)],
  );
  return fr.rows[0]!.id;
}

/** Manually freezes a step_run row exactly as the orchestrator does at scheduling. */
async function seedStepRun(
  runId: string,
  roleId: string,
  agentId: string,
  limitsSnapshot: Record<string, unknown>,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO step_runs
       (run_id, step_index, step_key, agent_id, role_id_snapshot, limits_snapshot, status, attempt, input, started_at)
     VALUES ($1, 0, 's', $2, $3, $4, 'running', 1, '{}', now())`,
    [runId, agentId, roleId, JSON.stringify(limitsSnapshot)],
  );
}

describe("getEnforcedLimits reads the frozen snapshot, not the live role", () => {
  it("returns the step_run snapshot even after roles.limits is mutated", async () => {
    const roleId = await seedRole("freeze-read-role", { run: { maxSkillInvocations: 2 } });
    const { rows } = await db.pool.query<{ id: string }>(
      "INSERT INTO agents (name, role_id) VALUES ($1, $2) RETURNING id",
      ["freeze-read-agent", roleId],
    );
    const agentId = rows[0]!.id;
    const runId = await seedBareRun("freeze-read-flow");

    await seedStepRun(runId, roleId, agentId, { run: { maxSkillInvocations: 2 } });

    // Admin "raises" the live ceiling mid-run.
    await setLiveLimits(roleId, { run: { maxSkillInvocations: 999 } });

    const enforced = await getEnforcedLimits(db.pool, runId, roleId);
    expect(enforced.run?.maxSkillInvocations).toBe(2); // frozen, NOT 999
  });

  it("falls back to live limits only when no step_run exists for the pair", async () => {
    const roleId = await seedRole("no-steprun-role", { run: { maxTokens: 77 } });
    const enforced = await getEnforcedLimits(
      db.pool,
      "99999999-9999-9999-9999-999999999999",
      roleId,
    );
    expect(enforced.run?.maxTokens).toBe(77);
  });

  it("an unknown role with no step_run still fails closed", async () => {
    await expect(
      getEnforcedLimits(
        db.pool,
        "99999999-9999-9999-9999-999999999999",
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toThrow(/not found.*failing closed/);
  });
});

describe("mid-run admin limit changes do NOT alter enforcement", () => {
  it("RAISING the live invocation cap mid-run does not widen a scheduled run", async () => {
    // Scheduled with a cap of 1. The cap is then RAISED to 99 live; the run
    // must still be enforced at the frozen value of 1 and fail on the 2nd call.
    const roleId = await seedRole("raise-cap-role", {
      skills: { "raise-cap@1": { maxInvocationsPerRun: 1 } },
    });
    await seedAgent("raise-cap-agent", roleId);
    let calls = 0;
    await seedSkill("raise-cap@1", async (i) => {
      calls += 1;
      // Widen the LIVE limit the instant the first invocation runs, so the
      // second check would pass if it read live config.
      await setLiveLimits(roleId, {
        skills: { "raise-cap@1": { maxInvocationsPerRun: 99 } },
      });
      return i;
    });
    await grant("raise-cap-agent", "raise-cap@1");

    const runId = await publishAndRun({
      name: "raise-cap-flow",
      steps: [{ key: "s", agent: "raise-cap-agent", skills: ["raise-cap@1", "raise-cap@1"] }],
    });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("failed");

    // Frozen at 1 → exactly one invocation, second denied.
    expect(calls).toBe(1);
    const events = await runEvents(runId);
    expect(events.filter((e) => e.event_type === "skill.invoked")).toHaveLength(1);
    expect(
      events.find((e) => e.event_type === "enforcement.limit_violation")!.payload,
    ).toMatchObject({ code: "limit_invocations", skillRef: "raise-cap@1" });

    // Snapshot is what is actually enforced; the live row is now wide open.
    const sr = await db.pool.query<{ limits_snapshot: { skills: Record<string, { maxInvocationsPerRun: number }> } }>(
      "SELECT limits_snapshot FROM step_runs WHERE run_id = $1 ORDER BY id LIMIT 1",
      [runId],
    );
    expect(sr.rows[0]!.limits_snapshot.skills["raise-cap@1"]!.maxInvocationsPerRun).toBe(1);
    const live = await db.pool.query<{ limits: { skills: Record<string, { maxInvocationsPerRun: number }> } }>(
      "SELECT limits FROM roles WHERE id = $1",
      [roleId],
    );
    expect(live.rows[0]!.limits.skills["raise-cap@1"]!.maxInvocationsPerRun).toBe(99);
  });

  it("a RETRY re-uses the frozen snapshot, not the limits raised between attempts", async () => {
    // The snapshot must be frozen ONCE per (run, role), not re-frozen on each
    // retry. The skill raises the live cap to 999 and throws on every call to
    // force a retry; attempt 2's step_run must carry forward attempt 1's frozen
    // cap of 5, not pick up the live 999 at retry-scheduling time.
    const roleId = await seedRole("retry-freeze-role", {
      skills: { "retry-freeze@1": { maxInvocationsPerRun: 5 } },
    });
    await seedAgent("retry-freeze-agent", roleId);
    await seedSkill("retry-freeze@1", async () => {
      await setLiveLimits(roleId, {
        skills: { "retry-freeze@1": { maxInvocationsPerRun: 999 } },
      });
      throw new Error("transient boom");
    });
    await grant("retry-freeze-agent", "retry-freeze@1");

    const runId = await publishAndRun({
      name: "retry-freeze-flow",
      steps: [
        {
          key: "go",
          agent: "retry-freeze-agent",
          skills: ["retry-freeze@1"],
          retries: { max_attempts: 2, backoff: "none" },
        },
      ],
    });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("failed");

    // Two attempts were scheduled; BOTH carry the original frozen cap (5), even
    // though the live role was widened to 999 during attempt 1.
    const sr = await db.pool.query<{
      attempt: number;
      limits_snapshot: { skills: Record<string, { maxInvocationsPerRun: number }> };
    }>("SELECT attempt, limits_snapshot FROM step_runs WHERE run_id = $1 ORDER BY attempt", [runId]);
    expect(sr.rows.length).toBe(2);
    for (const row of sr.rows) {
      expect(row.limits_snapshot.skills["retry-freeze@1"]!.maxInvocationsPerRun).toBe(5);
    }
    const live = await db.pool.query<{ limits: { skills: Record<string, { maxInvocationsPerRun: number }> } }>(
      "SELECT limits FROM roles WHERE id = $1",
      [roleId],
    );
    expect(live.rows[0]!.limits.skills["retry-freeze@1"]!.maxInvocationsPerRun).toBe(999);
  });

  it("LOWERING the live amount ceiling mid-run does not retroactively tighten enforcement", async () => {
    // Scheduled with a ceiling of 1000; the input amount is 800 (under it).
    // The ceiling is LOWERED to 1 live; the run must still pass at the frozen
    // 1000 and complete, proving the frozen snapshot — not the live row — wins.
    const roleId = await seedRole("lower-amt-role", {
      skills: { "lower-amt@1": { maxAmountPerInvocation: 1000 } },
    });
    await seedAgent("lower-amt-agent", roleId);
    await seedSkill("lower-amt@1", async (i) => {
      await setLiveLimits(roleId, {
        skills: { "lower-amt@1": { maxAmountPerInvocation: 1 } },
      });
      return i;
    });
    await grant("lower-amt-agent", "lower-amt@1");

    const runId = await publishAndRun(
      {
        name: "lower-amt-flow",
        steps: [{ key: "s", agent: "lower-amt-agent", skills: ["lower-amt@1"] }],
      },
      { amount: 800 },
    );
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
    expect(
      (await runEvents(runId)).some((e) => e.event_type === "enforcement.limit_violation"),
    ).toBe(false);
  });

  it("a negative amount is rejected end-to-end through the executor", async () => {
    const roleId = await seedRole("neg-amt-role", {
      skills: { "neg-amt@1": { maxAmountPerInvocation: 1000 } },
    });
    await seedAgent("neg-amt-agent", roleId);
    let executed = false;
    await seedSkill("neg-amt@1", async (i) => {
      executed = true;
      return i;
    });
    await grant("neg-amt-agent", "neg-amt@1");

    const runId = await publishAndRun(
      {
        name: "neg-amt-flow",
        steps: [{ key: "s", agent: "neg-amt-agent", skills: ["neg-amt@1"] }],
      },
      { amount: -1_000_000 },
    );
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    // The skill must NEVER have run — the cap denied before invocation.
    expect(executed).toBe(false);
    expect(
      (await runEvents(runId)).find((e) => e.event_type === "enforcement.limit_violation")!
        .payload,
    ).toMatchObject({ code: "limit_amount" });
  });
});

describe("checkSkillLimit / checkTokenBudget honour the frozen snapshot", () => {
  it("checkSkillLimit reads the snapshot's cap, not the mutated live cap", async () => {
    const roleId = await seedRole("ckskill-role", {
      skills: { "ck@1": { maxInvocationsPerRun: 1 } },
    });
    const { rows } = await db.pool.query<{ id: string }>(
      "INSERT INTO agents (name, role_id) VALUES ($1, $2) RETURNING id",
      ["ckskill-agent", roleId],
    );
    const runId = await seedBareRun("ckskill-flow");
    await seedStepRun(runId, roleId, rows[0]!.id, {
      skills: { "ck@1": { maxInvocationsPerRun: 1 } },
    });

    // Live cap raised to 50 — must be ignored.
    await setLiveLimits(roleId, { skills: { "ck@1": { maxInvocationsPerRun: 50 } } });

    // 0 prior invocations: allowed (1 of 1).
    await expect(
      checkSkillLimit(db.pool, { runId, roleId, skillRef: "ck@1", input: {} }),
    ).resolves.toBeUndefined();

    // Simulate 1 prior invocation by writing a skill.invoked audit row, then
    // the next check must DENY at the frozen cap of 1 (not the live 50).
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const { recordEvent } = await import("../audit/writer.js");
      await recordEvent(client, {
        eventType: "skill.invoked",
        actor: { type: "agent", id: rows[0]!.id, name: "ckskill-agent" },
        entityType: "step_run",
        entityId: runId,
        runId,
        payload: { skillRef: "ck@1" },
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    await expect(
      checkSkillLimit(db.pool, { runId, roleId, skillRef: "ck@1", input: {} }),
    ).rejects.toThrow(/invocation limit/);
  });

  it("checkTokenBudget reads the snapshot's budget, not the mutated live budget", async () => {
    const roleId = await seedRole("cktok-role", { run: { maxTokens: 100 } });
    const { rows } = await db.pool.query<{ id: string }>(
      "INSERT INTO agents (name, role_id) VALUES ($1, $2) RETURNING id",
      ["cktok-agent", roleId],
    );
    const runId = await seedBareRun("cktok-flow");
    await seedStepRun(runId, roleId, rows[0]!.id, { run: { maxTokens: 100 } });

    // Live budget raised to 1,000,000 — must be ignored.
    await setLiveLimits(roleId, { run: { maxTokens: 1_000_000 } });

    // nextEstimate 150 exceeds the FROZEN 100 → must reject.
    await expect(
      checkTokenBudget(db.pool, { runId, roleId, nextEstimate: 150 }),
    ).rejects.toThrow(/token budget/);
    // Under the frozen budget → resolves.
    await expect(
      checkTokenBudget(db.pool, { runId, roleId, nextEstimate: 50 }),
    ).resolves.toBeUndefined();
  });
});

// ----------------------------------------------------- argument policy (pure)

describe("assertSkillLimits — destination allowlist", () => {
  const cfg: SkillLimitConfig = {
    allowlist: { field: "destination", values: ["0xSAFE", "0xTREASURY"] },
  };

  it("allows a value on the allowlist", () => {
    expect(() =>
      assertSkillLimits(cfg, 0, { destination: "0xSAFE" }, "transfer@1"),
    ).not.toThrow();
  });

  it("denies a value off the allowlist", () => {
    try {
      assertSkillLimits(cfg, 0, { destination: "0xATTACKER" }, "transfer@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect(err).toBeInstanceOf(LimitViolationError);
      expect((err as LimitViolationError).code).toBe("limit_allowlist");
    }
  });

  it("FAILS CLOSED on a missing field", () => {
    try {
      assertSkillLimits(cfg, 0, { note: "no destination" }, "transfer@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect((err as LimitViolationError).code).toBe("limit_allowlist_unreadable");
    }
  });

  it("FAILS CLOSED on a non-string field (number, null, array, object)", () => {
    for (const bad of [123, null, ["0xSAFE"], { v: "0xSAFE" }]) {
      try {
        assertSkillLimits(cfg, 0, { destination: bad }, "transfer@1");
        throw new Error("expected a LimitViolationError");
      } catch (err) {
        expect((err as LimitViolationError).code).toBe("limit_allowlist_unreadable");
      }
    }
  });

  it("is exact, not substring or case-insensitive", () => {
    for (const sneaky of ["0xSAFE2", "0xsafe", "SAFE", " 0xSAFE"]) {
      expect(() =>
        assertSkillLimits(cfg, 0, { destination: sneaky }, "transfer@1"),
      ).toThrowError(/not on the allowlist/);
    }
  });

  it("an empty allowlist denies everything (fail closed)", () => {
    const empty: SkillLimitConfig = { allowlist: { field: "to", values: [] } };
    expect(() => assertSkillLimits(empty, 0, { to: "anything" }, "x@1")).toThrowError(
      /not on the allowlist/,
    );
  });
});

describe("normalizePath + isPathWithinPrefix — traversal containment", () => {
  it("normalizes . and .. and redundant separators", () => {
    expect(normalizePath("/app/data/../data/./x")).toBe("/app/data/x");
    expect(normalizePath("/app//data/")).toBe("/app/data");
    expect(normalizePath("a/b/../c")).toBe("a/c");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("");
    expect(normalizePath("./")).toBe("");
    expect(normalizePath("../../x")).toBe("../../x"); // double-leading-.. stack branch
  });

  it("rejects a pure-traversal prefix that escapes upward (P1 fail-open regression)", () => {
    // A prefix that itself climbs above its parent has no containment root: a
    // textual startsWith would wrongly accept a value that escapes even further.
    expect(isPathWithinPrefix("../../etc/passwd", "..")).toBe(false);
    expect(isPathWithinPrefix("../../../root", "../..")).toBe(false);
    expect(isPathWithinPrefix("../shared/x", "../shared")).toBe(false);
    expect(isPathWithinPrefix("../sharedXXX", "../shared")).toBe(false);
  });

  it("a value that escapes upward is never contained, and a prefix that collapses to empty fails closed", () => {
    expect(isPathWithinPrefix("../etc", "..")).toBe(false);
    expect(isPathWithinPrefix("../../x", "/app")).toBe(false);
    expect(isPathWithinPrefix("/anything", "a/..")).toBe(false); // prefix collapses to ""
  });

  it("an absolute path cannot .. above its root", () => {
    expect(normalizePath("/../../etc/passwd")).toBe("/etc/passwd");
  });

  it("treats backslashes as separators (no Windows-style evasion)", () => {
    expect(normalizePath("\\app\\data\\..\\..\\etc")).toBe("/etc");
    expect(isPathWithinPrefix("data\\..\\..\\etc", "data")).toBe(false);
  });

  it("accepts a path at or beneath the prefix", () => {
    expect(isPathWithinPrefix("/app/data", "/app/data")).toBe(true);
    expect(isPathWithinPrefix("/app/data/file.csv", "/app/data")).toBe(true);
    expect(isPathWithinPrefix("/app/data/sub/dir/x", "/app/data")).toBe(true);
    expect(isPathWithinPrefix("/app/data/", "/app/data")).toBe(true);
  });

  it("rejects traversal that escapes the prefix", () => {
    expect(isPathWithinPrefix("/app/data/../../etc/passwd", "/app/data")).toBe(false);
    expect(isPathWithinPrefix("/app/data/../secret", "/app/data")).toBe(false);
  });

  it("rejects prefix-confusion siblings", () => {
    // "/app/data-secret" must NOT count as inside "/app/data".
    expect(isPathWithinPrefix("/app/data-secret", "/app/data")).toBe(false);
    expect(isPathWithinPrefix("/app/database", "/app/data")).toBe(false);
  });

  it("never matches a relative value against an absolute prefix or vice versa", () => {
    expect(isPathWithinPrefix("data/x", "/app/data")).toBe(false);
    expect(isPathWithinPrefix("/app/data/x", "app/data")).toBe(false);
  });

  it("handles relative prefixes and escaping relatives", () => {
    expect(isPathWithinPrefix("data/x", "data")).toBe(true);
    expect(isPathWithinPrefix("data/../../etc", "data")).toBe(false);
  });

  it("an empty prefix contains nothing (fail closed)", () => {
    expect(isPathWithinPrefix("/anything", "")).toBe(false);
  });
});

describe("assertSkillLimits — path scope", () => {
  const cfg: SkillLimitConfig = { pathScope: { field: "path", prefix: "/workspace/project" } };

  it("allows a path under the prefix", () => {
    expect(() =>
      assertSkillLimits(cfg, 0, { path: "/workspace/project/src/a.ts" }, "fs-delete@1"),
    ).not.toThrow();
  });

  it("denies a path outside the prefix", () => {
    try {
      assertSkillLimits(cfg, 0, { path: "/etc/passwd" }, "fs-delete@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect((err as LimitViolationError).code).toBe("limit_path");
    }
  });

  it("denies traversal out of the prefix", () => {
    expect(() =>
      assertSkillLimits(
        cfg,
        0,
        { path: "/workspace/project/../../etc/passwd" },
        "fs-delete@1",
      ),
    ).toThrowError(/outside the allowed prefix/);
  });

  it("FAILS CLOSED on missing, empty, or non-string path", () => {
    for (const bad of [undefined, "", 123, null, {}]) {
      const input = bad === undefined ? {} : { path: bad };
      try {
        assertSkillLimits(cfg, 0, input, "fs-delete@1");
        throw new Error("expected a LimitViolationError");
      } catch (err) {
        expect((err as LimitViolationError).code).toBe("limit_path_unreadable");
      }
    }
  });
});

describe("assertSkillLimits — combined amount + allowlist + path predicates", () => {
  const cfg: SkillLimitConfig = {
    maxAmountPerInvocation: 1000,
    allowlist: { field: "destination", values: ["0xSAFE"] },
    pathScope: { field: "path", prefix: "/workspace/project" },
  };

  it("passes only when the input satisfies ALL three predicates", () => {
    expect(() =>
      assertSkillLimits(
        cfg,
        0,
        { amount: 500, destination: "0xSAFE", path: "/workspace/project/a.ts" },
        "do-all@1",
      ),
    ).not.toThrow();
  });

  it("amount-over fails with limit_amount even when allowlist AND path would also fail (first-violation ordering)", () => {
    // checks run amount → allowlist → pathScope, so the amount violation wins
    // even though the destination is off-list and the path escapes the prefix.
    try {
      assertSkillLimits(
        cfg,
        0,
        { amount: 5000, destination: "0xATTACKER", path: "/etc/passwd" },
        "do-all@1",
      );
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect((err as LimitViolationError).code).toBe("limit_amount");
      expect((err as LimitViolationError).message).toContain("exceeds");
    }
  });

  it("allowlist-ok but path-bad → limit_path (allowlist precedes pathScope)", () => {
    try {
      assertSkillLimits(
        cfg,
        0,
        { amount: 500, destination: "0xSAFE", path: "/etc/passwd" },
        "do-all@1",
      );
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect((err as LimitViolationError).code).toBe("limit_path");
    }
  });
});

describe("argument policy — non-string exhaustiveness (booleans, arrays)", () => {
  it("allowlist denies boolean true/false as limit_allowlist_unreadable", () => {
    const cfg: SkillLimitConfig = {
      allowlist: { field: "destination", values: ["0xSAFE"] },
    };
    for (const bad of [true, false]) {
      try {
        assertSkillLimits(cfg, 0, { destination: bad }, "transfer@1");
        throw new Error("expected a LimitViolationError");
      } catch (err) {
        expect((err as LimitViolationError).code).toBe("limit_allowlist_unreadable");
      }
    }
  });

  it("pathScope denies boolean true/false and an array as limit_path_unreadable", () => {
    const cfg: SkillLimitConfig = { pathScope: { field: "path", prefix: "/workspace/project" } };
    for (const bad of [true, false, ["/workspace/project/x"]]) {
      try {
        assertSkillLimits(cfg, 0, { path: bad }, "fs-delete@1");
        throw new Error("expected a LimitViolationError");
      } catch (err) {
        expect((err as LimitViolationError).code).toBe("limit_path_unreadable");
      }
    }
  });
});

describe("argument policy — empty-string semantics (deliberate asymmetry)", () => {
  it("an allowlist that includes \"\" ALLOWS an empty-string input", () => {
    const cfg: SkillLimitConfig = { allowlist: { field: "memo", values: ["", "0xSAFE"] } };
    expect(() => assertSkillLimits(cfg, 0, { memo: "" }, "note@1")).not.toThrow();
  });

  it("an empty-string input NOT on the allowlist yields limit_allowlist", () => {
    const cfg: SkillLimitConfig = { allowlist: { field: "memo", values: ["0xSAFE"] } };
    try {
      assertSkillLimits(cfg, 0, { memo: "" }, "note@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      // An empty string is a readable string, just not on the list → off-list.
      expect((err as LimitViolationError).code).toBe("limit_allowlist");
    }
  });

  it("pathScope rejects an empty-string path as limit_path_unreadable (the asymmetry)", () => {
    // Unlike the allowlist, an empty-string PATH is treated as unreadable, never
    // as a value that could be on/off a list — there is no empty path to scope.
    const cfg: SkillLimitConfig = { pathScope: { field: "path", prefix: "/workspace/project" } };
    try {
      assertSkillLimits(cfg, 0, { path: "" }, "fs-delete@1");
      throw new Error("expected a LimitViolationError");
    } catch (err) {
      expect((err as LimitViolationError).code).toBe("limit_path_unreadable");
    }
  });
});

// --------------------------------------------- argument policy (end-to-end)

describe("argument policy is enforced end-to-end through the executor", () => {
  it("an off-allowlist destination is denied before the skill runs", async () => {
    const roleId = await seedRole("allow-e2e-role", {
      skills: { "send@1": { allowlist: { field: "destination", values: ["0xSAFE"] } } },
    });
    await seedAgent("allow-e2e-agent", roleId);
    let executed = false;
    await seedSkill("send@1", async (i) => {
      executed = true;
      return i;
    });
    await grant("allow-e2e-agent", "send@1");

    const runId = await publishAndRun(
      { name: "allow-e2e-flow", steps: [{ key: "s", agent: "allow-e2e-agent", skills: ["send@1"] }] },
      { destination: "0xATTACKER" },
    );
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    expect(executed).toBe(false);
    expect(
      (await runEvents(runId)).find((e) => e.event_type === "enforcement.limit_violation")!
        .payload,
    ).toMatchObject({ code: "limit_allowlist" });
  });

  it("a path outside the scope is denied before the skill runs", async () => {
    const roleId = await seedRole("path-e2e-role", {
      skills: { "wipe@1": { pathScope: { field: "path", prefix: "/workspace/project" } } },
    });
    await seedAgent("path-e2e-agent", roleId);
    let executed = false;
    await seedSkill("wipe@1", async (i) => {
      executed = true;
      return i;
    });
    await grant("path-e2e-agent", "wipe@1");

    const runId = await publishAndRun(
      { name: "path-e2e-flow", steps: [{ key: "s", agent: "path-e2e-agent", skills: ["wipe@1"] }] },
      { path: "/etc/passwd" },
    );
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    expect(executed).toBe(false);
    expect(
      (await runEvents(runId)).find((e) => e.event_type === "enforcement.limit_violation")!
        .payload,
    ).toMatchObject({ code: "limit_path" });
  });

  it("an on-allowlist destination is allowed and the skill runs to completion", async () => {
    const roleId = await seedRole("allow-ok-role", {
      skills: { "send-ok@1": { allowlist: { field: "destination", values: ["0xSAFE"] } } },
    });
    await seedAgent("allow-ok-agent", roleId);
    let executed = false;
    await seedSkill("send-ok@1", async (i) => {
      executed = true;
      return i;
    });
    await grant("allow-ok-agent", "send-ok@1");

    const runId = await publishAndRun(
      { name: "allow-ok-flow", steps: [{ key: "s", agent: "allow-ok-agent", skills: ["send-ok@1"] }] },
      { destination: "0xSAFE" },
    );
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
    expect(executed).toBe(true);
    expect(
      (await runEvents(runId)).some((e) => e.event_type === "enforcement.limit_violation"),
    ).toBe(false);
  });

  it("a path under the prefix is allowed and the skill runs to completion", async () => {
    const roleId = await seedRole("path-ok-role", {
      skills: { "write-ok@1": { pathScope: { field: "path", prefix: "/workspace/project" } } },
    });
    await seedAgent("path-ok-agent", roleId);
    let executed = false;
    await seedSkill("write-ok@1", async (i) => {
      executed = true;
      return i;
    });
    await grant("path-ok-agent", "write-ok@1");

    const runId = await publishAndRun(
      { name: "path-ok-flow", steps: [{ key: "s", agent: "path-ok-agent", skills: ["write-ok@1"] }] },
      { path: "/workspace/project/src/a.ts" },
    );
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
    expect(executed).toBe(true);
    expect(
      (await runEvents(runId)).some((e) => e.event_type === "enforcement.limit_violation"),
    ).toBe(false);
  });
});

describe("mid-run admin changes do NOT widen frozen argument policy", () => {
  it("WIDENING the live allowlist mid-run does not admit a destination off the frozen list", async () => {
    // Frozen with values:['0xSAFE']. The skill widens the LIVE allowlist to
    // include '0xATTACKER'; a run targeting '0xATTACKER' must still be denied at
    // the frozen list and the skill must never execute.
    const roleId = await seedRole("widen-allow-role", {
      skills: { "widen-send@1": { allowlist: { field: "destination", values: ["0xSAFE"] } } },
    });
    await seedAgent("widen-allow-agent", roleId);
    let executed = false;
    await seedSkill("widen-send@1", async (i) => {
      executed = true;
      // Widen the LIVE list — must be ignored by the already-frozen run.
      await setLiveLimits(roleId, {
        skills: {
          "widen-send@1": { allowlist: { field: "destination", values: ["0xSAFE", "0xATTACKER"] } },
        },
      });
      return i;
    });
    await grant("widen-allow-agent", "widen-send@1");

    const runId = await publishAndRun(
      {
        name: "widen-allow-flow",
        steps: [{ key: "s", agent: "widen-allow-agent", skills: ["widen-send@1"] }],
      },
      { destination: "0xATTACKER" },
    );
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("failed");
    // Frozen list wins: never on-list, so the skill never ran.
    expect(executed).toBe(false);
    expect(
      (await runEvents(runId)).find((e) => e.event_type === "enforcement.limit_violation")!
        .payload,
    ).toMatchObject({ code: "limit_allowlist", skillRef: "widen-send@1" });
  });

  it("WIDENING the live pathScope prefix mid-run does not admit a path outside the frozen prefix", async () => {
    // Frozen with prefix '/workspace/project'. The skill widens the LIVE prefix
    // to '/'; a run targeting '/etc/passwd' must still be denied at the frozen
    // prefix and the skill must never execute.
    const roleId = await seedRole("widen-path-role", {
      skills: { "widen-wipe@1": { pathScope: { field: "path", prefix: "/workspace/project" } } },
    });
    await seedAgent("widen-path-agent", roleId);
    let executed = false;
    await seedSkill("widen-wipe@1", async (i) => {
      executed = true;
      await setLiveLimits(roleId, {
        skills: { "widen-wipe@1": { pathScope: { field: "path", prefix: "/" } } },
      });
      return i;
    });
    await grant("widen-path-agent", "widen-wipe@1");

    const runId = await publishAndRun(
      {
        name: "widen-path-flow",
        steps: [{ key: "s", agent: "widen-path-agent", skills: ["widen-wipe@1"] }],
      },
      { path: "/etc/passwd" },
    );
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("failed");
    expect(executed).toBe(false);
    expect(
      (await runEvents(runId)).find((e) => e.event_type === "enforcement.limit_violation")!
        .payload,
    ).toMatchObject({ code: "limit_path", skillRef: "widen-wipe@1" });
  });
});
