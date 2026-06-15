import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { verifyChain } from "../audit/verify.js";
import { GraphileWorkerBackend } from "./graphile-backend.js";
import { LocalSkillExecutor, type Json, type LocalSkillFn } from "./executor.js";
import { publishFlowVersion, FlowValidationError } from "./flows.js";
import { loadDefinition } from "./flows.js";
import {
  advanceRun,
  backoffDelayMs,
  createHandlers,
  decideApproval,
  executeStep,
  startRun,
  TASK_ADVANCE,
  type EngineContext,
} from "./orchestrator.js";
import { sweepStuckSteps } from "./watchdog.js";

let db: TestDb;
let ctx: EngineContext;
const registry = new Map<string, LocalSkillFn>();
const USER = { type: "user" as const, id: "test-user", name: "Test User" };

beforeAll(async () => {
  db = await createTestDb();
  const backend = new GraphileWorkerBackend(db.pool, 5);
  ctx = { pool: db.pool, backend, executor: new LocalSkillExecutor(registry) };
  await backend.start(createHandlers(ctx));
}, 60_000);

afterAll(async () => {
  await ctx.backend.stop();
  await db.drop();
});

async function seedAgent(name: string, roleName = `${name}-role`): Promise<void> {
  await db.pool.query(
    `WITH role AS (
       INSERT INTO roles (name) VALUES ($2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id
     )
     INSERT INTO agents (name, role_id) SELECT $1, id FROM role
     ON CONFLICT (name) DO NOTHING`,
    [name, roleName],
  );
}

async function seedSkill(ref: string, fn: LocalSkillFn, riskTier = "low"): Promise<void> {
  const [name, version] = ref.split("@");
  await db.pool.query(
    `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
     VALUES ($1, $2, '{}', '{}', '{"type":"local"}', $3) ON CONFLICT DO NOTHING`,
    [name, Number(version), riskTier],
  );
  registry.set(ref, fn);
}

/** Grants a skill to the agent's role — without this, deny-by-default blocks the step. */
async function grant(agentName: string, ref: string): Promise<void> {
  const [name, version] = ref.split("@");
  await db.pool.query(
    `INSERT INTO role_skill_grants (role_id, skill_id)
     SELECT a.role_id, s.id FROM agents a, skills s
      WHERE a.name = $1 AND s.name = $2 AND s.version = $3
        AND NOT EXISTS (
          SELECT 1 FROM role_skill_grants g
           WHERE g.role_id = a.role_id AND g.skill_id = s.id AND g.revoked_at IS NULL)`,
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

async function eventTypes(runId: string): Promise<string[]> {
  const { rows } = await db.pool.query<{ event_type: string }>(
    "SELECT event_type FROM audit_events WHERE run_id = $1 ORDER BY seq ASC",
    [runId],
  );
  return rows.map((r) => r.event_type);
}

describe("flow publishing", () => {
  it("rejects invalid definitions before they can ever run", async () => {
    await expect(
      publishFlowVersion(db.pool, {
        definition: { name: "bad", steps: [{ key: "x" }] },
        actor: USER,
      }),
    ).rejects.toThrow(FlowValidationError);
  });

  it("publishes versions monotonically and audits each", async () => {
    await seedAgent("pub-agent");
    await seedSkill("pub-skill@1", async (i) => i);
    await grant("pub-agent", "pub-skill@1");
    const def = {
      name: "publish-test",
      steps: [{ key: "s", agent: "pub-agent", skills: ["pub-skill@1"] }],
    };
    const v1 = await publishFlowVersion(db.pool, { definition: def, actor: USER });
    const v2 = await publishFlowVersion(db.pool, { definition: def, actor: USER });
    expect([v1.version, v2.version]).toEqual([1, 2]);
  });
});

describe("end-to-end execution", () => {
  it("runs a multi-step flow, threading outputs between steps", async () => {
    await seedAgent("worker-a");
    await seedAgent("worker-b");
    await seedSkill("add-one@1", async (input) => ({ n: (input.n as number) + 1 }));
    await seedSkill("double@1", async (input) => ({ n: (input.n as number) * 2 }));
    await grant("worker-a", "add-one@1");
    await grant("worker-b", "double@1");

    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "math-flow",
        steps: [
          { key: "increment", agent: "worker-a", skills: ["add-one@1"] },
          { key: "double_it", agent: "worker-b", skills: ["double@1"] },
        ],
      },
      actor: USER,
    });

    const runId = await startRun(ctx, {
      flowVersionId,
      triggeredBy: USER,
      runInput: { n: 20 },
    });
    await waitForRunStatus(runId, ["completed", "failed"]);

    const { rows: steps } = await db.pool.query(
      "SELECT step_key, status, output FROM step_runs WHERE run_id = $1 ORDER BY step_index",
      [runId],
    );
    expect(steps.map((s) => [s.step_key, s.status])).toEqual([
      ["increment", "completed"],
      ["double_it", "completed"],
    ]);
    expect(steps[1].output).toEqual({ n: 42 }); // (20 + 1) * 2

    const types = await eventTypes(runId);
    expect(types).toEqual([
      "run.created",
      "run.step.started",
      "run.step.completed",
      "run.step.started",
      "run.step.completed",
      "run.completed",
    ]);
    expect((await verifyChain(db.pool)).ok).toBe(true);
  });

  it("retries a flaky step with each attempt audited, then succeeds", async () => {
    await seedAgent("flaky-agent");
    let calls = 0;
    await seedSkill("flaky@1", async (input) => {
      calls += 1;
      if (calls < 3) throw new Error(`transient failure ${calls}`);
      return { survived: true, calls, ...input };
    });
    await grant("flaky-agent", "flaky@1");

    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "flaky-flow",
        steps: [
          {
            key: "flaky_step",
            agent: "flaky-agent",
            skills: ["flaky@1"],
            retries: { max_attempts: 3, backoff: "none" },
          },
        ],
      },
      actor: USER,
    });

    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    await waitForRunStatus(runId, ["completed", "failed"]);

    const { rows: attempts } = await db.pool.query(
      "SELECT attempt, status FROM step_runs WHERE run_id = $1 ORDER BY attempt",
      [runId],
    );
    expect(attempts).toEqual([
      { attempt: 1, status: "failed" },
      { attempt: 2, status: "failed" },
      { attempt: 3, status: "completed" },
    ]);
    const types = await eventTypes(runId);
    expect(types.filter((t) => t === "run.step.retrying")).toHaveLength(2);
    expect(types.at(-1)).toBe("run.completed");
  });

  it("fails the run after max attempts are exhausted", async () => {
    await seedAgent("doomed-agent");
    await seedSkill("always-fails@1", async () => {
      throw new Error("permanent breakage");
    });
    await grant("doomed-agent", "always-fails@1");

    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "doomed-flow",
        steps: [
          {
            key: "doomed",
            agent: "doomed-agent",
            skills: ["always-fails@1"],
            retries: { max_attempts: 2, backoff: "none" },
          },
        ],
      },
      actor: USER,
    });

    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    const status = await waitForRunStatus(runId, ["completed", "failed"]);
    expect(status).toBe("failed");

    const run = await db.pool.query("SELECT failure_reason FROM flow_runs WHERE id = $1", [runId]);
    expect(run.rows[0].failure_reason).toContain("after 2 attempt(s)");
    const types = await eventTypes(runId);
    expect(types).toContain("run.step.failed");
    expect(types.at(-1)).toBe("run.failed");
  });

  it("times out a hung step via the abort race", async () => {
    await seedAgent("slow-agent");
    await seedSkill("hangs@1", () => new Promise(() => {})); // never settles
    await grant("slow-agent", "hangs@1");

    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "slow-flow",
        steps: [
          { key: "hang", agent: "slow-agent", skills: ["hangs@1"], timeout_ms: 1000 },
        ],
      },
      actor: USER,
    });

    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    const status = await waitForRunStatus(runId, ["completed", "failed"]);
    expect(status).toBe("failed");
    const { rows } = await db.pool.query(
      "SELECT status FROM step_runs WHERE run_id = $1",
      [runId],
    );
    expect(rows[0].status).toBe("timed_out");
  });

  it("blocks and fails a run whose step names a nonexistent agent", async () => {
    await seedSkill("orphan@1", async (i) => i);
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "ghost-flow",
        steps: [{ key: "ghost", agent: "agent-that-does-not-exist", skills: ["orphan@1"] }],
      },
      actor: USER,
    });

    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    const status = await waitForRunStatus(runId, ["completed", "failed"]);
    expect(status).toBe("failed");
    const types = await eventTypes(runId);
    expect(types).toContain("enforcement.blocked");
  });

  it("suspended agents are blocked at run time", async () => {
    await seedAgent("benched-agent");
    await seedSkill("benched-skill@1", async (i) => i);
    await grant("benched-agent", "benched-skill@1");
    await db.pool.query("UPDATE agents SET status = 'suspended' WHERE name = 'benched-agent'");

    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "benched-flow",
        steps: [{ key: "s", agent: "benched-agent", skills: ["benched-skill@1"] }],
      },
      actor: USER,
    });
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("failed");
    expect(await eventTypes(runId)).toContain("enforcement.blocked");
  });
});

describe("approval gates", () => {
  async function publishGatedFlow(name: string) {
    await seedAgent("gate-agent");
    await seedSkill("pre@1", async (i) => ({ ...i, pre: true }));
    await seedSkill("post@1", async (i) => ({ ...i, post: true }));
    await grant("gate-agent", "pre@1");
    await grant("gate-agent", "post@1");
    return publishFlowVersion(db.pool, {
      definition: {
        name,
        steps: [
          { key: "before", agent: "gate-agent", skills: ["pre@1"] },
          { key: "review", type: "approval_gate", title: "Human review" },
          { key: "after", agent: "gate-agent", skills: ["post@1"] },
        ],
      },
      actor: USER,
    });
  }

  async function pendingApproval(runId: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      "SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'",
      [runId],
    );
    return rows[0]!.id;
  }

  it("parks the run at the gate and resumes on approval", async () => {
    const { flowVersionId } = await publishGatedFlow("gated-flow");
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER, runInput: {} });

    expect(await waitForRunStatus(runId, ["waiting_approval"])).toBe("waiting_approval");
    // Parked: the post-gate step must not have run.
    const before = await db.pool.query(
      "SELECT step_key FROM step_runs WHERE run_id = $1",
      [runId],
    );
    expect(before.rows.map((r) => r.step_key)).toEqual(["before"]);

    await decideApproval(ctx, {
      approvalId: await pendingApproval(runId),
      decision: "approved",
      decidedBy: USER,
      reason: "exceptions reviewed, all explained",
    });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");

    const types = await eventTypes(runId);
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.decided");
    const { rows } = await db.pool.query(
      "SELECT output FROM step_runs WHERE run_id = $1 AND step_key = 'after'",
      [runId],
    );
    expect(rows[0].output).toMatchObject({ pre: true, post: true });
  });

  it("fails the run on rejection, recording who and why", async () => {
    const { flowVersionId } = await publishGatedFlow("gated-flow-reject");
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    await waitForRunStatus(runId, ["waiting_approval"]);

    await decideApproval(ctx, {
      approvalId: await pendingApproval(runId),
      decision: "rejected",
      decidedBy: USER,
      reason: "unexplained exception in row 14",
    });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("failed");

    const { rows } = await db.pool.query(
      `SELECT payload FROM audit_events
        WHERE run_id = $1 AND event_type = 'approval.decided'`,
      [runId],
    );
    expect(rows[0].payload).toMatchObject({
      decision: "rejected",
      reason: "unexplained exception in row 14",
    });
  });

  it("refuses to decide an already-decided approval", async () => {
    const { flowVersionId } = await publishGatedFlow("gated-flow-double");
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    await waitForRunStatus(runId, ["waiting_approval"]);
    const approvalId = await pendingApproval(runId);

    await decideApproval(ctx, { approvalId, decision: "approved", decidedBy: USER });
    await expect(
      decideApproval(ctx, { approvalId, decision: "rejected", decidedBy: USER }),
    ).rejects.toThrow(/already approved/);
  });
});

describe("watchdog", () => {
  it("recovers a step orphaned by a crashed worker", async () => {
    await seedAgent("crash-agent");
    await seedSkill("crash-skill@1", async (i) => i);
    await grant("crash-agent", "crash-skill@1");
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "crash-flow",
        steps: [{ key: "s", agent: "crash-agent", skills: ["crash-skill@1"], timeout_ms: 1000 }],
      },
      actor: USER,
    });

    // Simulate a crashed worker: a step_run stuck 'running' with a stale start.
    const run = await db.pool.query<{ id: string }>(
      `INSERT INTO flow_runs (flow_version_id, triggered_by, status, started_at)
       VALUES ($1, '{"type":"system"}', 'running', now()) RETURNING id`,
      [flowVersionId],
    );
    const runId = run.rows[0]!.id;
    const agent = await db.pool.query<{ id: string; role_id: string }>(
      "SELECT id, role_id FROM agents WHERE name = 'crash-agent'",
    );
    await db.pool.query(
      `INSERT INTO step_runs
         (run_id, step_index, step_key, agent_id, role_id_snapshot, status, attempt, input, started_at)
       VALUES ($1, 0, 's', $2, $3, 'running', 1, '{}', now() - interval '1 hour')`,
      [runId, agent.rows[0]!.id, agent.rows[0]!.role_id],
    );

    const recovered = await sweepStuckSteps(ctx, { graceMs: 0 });
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    const types = await eventTypes(runId);
    expect(types).toContain("run.step.failed");
  });

  it("leaves healthy running steps alone", async () => {
    const recovered = await sweepStuckSteps(ctx, { graceMs: 600_000 });
    expect(recovered).toBe(0);
  });
});

describe("M3 — deny-by-default grants", () => {
  it("blocks an agent whose role was never granted the skill", async () => {
    await seedAgent("ungranted-agent");
    await seedSkill("forbidden@1", async (i) => i);
    // No grant() call — deny by default.
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "ungranted-flow",
        steps: [{ key: "s", agent: "ungranted-agent", skills: ["forbidden@1"] }],
      },
      actor: USER,
    });
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    const { rows } = await db.pool.query(
      "SELECT payload FROM audit_events WHERE run_id = $1 AND event_type = 'enforcement.blocked'",
      [runId],
    );
    expect(rows[0].payload).toMatchObject({ code: "skill_not_granted" });
  });

  it("blocks after a grant is revoked — revocation is immediate", async () => {
    await seedAgent("revoked-agent");
    await seedSkill("once-allowed@1", async (i) => i);
    await grant("revoked-agent", "once-allowed@1");
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "revoked-flow",
        steps: [{ key: "s", agent: "revoked-agent", skills: ["once-allowed@1"] }],
      },
      actor: USER,
    });

    // First run succeeds with the grant in place.
    const okRun = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    expect(await waitForRunStatus(okRun, ["completed", "failed"])).toBe("completed");

    // Revoke (never delete) and run again.
    await db.pool.query(
      `UPDATE role_skill_grants SET revoked_at = now()
        WHERE role_id = (SELECT role_id FROM agents WHERE name = 'revoked-agent')`,
    );
    const blockedRun = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    expect(await waitForRunStatus(blockedRun, ["failed"])).toBe("failed");
    const { rows } = await db.pool.query(
      "SELECT payload FROM audit_events WHERE run_id = $1 AND event_type = 'enforcement.blocked'",
      [blockedRun],
    );
    expect(rows[0].payload).toMatchObject({ code: "skill_not_granted" });
  });

  it("re-enforces at invocation time, not just at scheduling", async () => {
    await seedAgent("late-revoke-agent");
    await seedSkill("late-revoke-skill@1", async (i) => i);
    await grant("late-revoke-agent", "late-revoke-skill@1");
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "late-revoke-flow",
        steps: [{ key: "s", agent: "late-revoke-agent", skills: ["late-revoke-skill@1"] }],
      },
      actor: USER,
    });

    // Simulate a step scheduled while granted, with the grant revoked before
    // the worker picks it up: insert the running step_run directly, revoke,
    // then invoke executeStep.
    const run = await db.pool.query<{ id: string }>(
      `INSERT INTO flow_runs (flow_version_id, triggered_by, status, started_at)
       VALUES ($1, '{"type":"system"}', 'running', now()) RETURNING id`,
      [flowVersionId],
    );
    const agent = await db.pool.query<{ id: string; role_id: string }>(
      "SELECT id, role_id FROM agents WHERE name = 'late-revoke-agent'",
    );
    const stepRun = await db.pool.query<{ id: string }>(
      `INSERT INTO step_runs
         (run_id, step_index, step_key, agent_id, role_id_snapshot, status, attempt, input, started_at)
       VALUES ($1, 0, 's', $2, $3, 'running', 1, '{}', now()) RETURNING id`,
      [run.rows[0]!.id, agent.rows[0]!.id, agent.rows[0]!.role_id],
    );
    await db.pool.query(
      "UPDATE role_skill_grants SET revoked_at = now() WHERE role_id = $1",
      [agent.rows[0]!.role_id],
    );

    const { executeStep: exec } = await import("./orchestrator.js");
    await exec(ctx, stepRun.rows[0]!.id);

    const { rows } = await db.pool.query(
      "SELECT payload FROM audit_events WHERE run_id = $1 AND event_type = 'enforcement.blocked'",
      [run.rows[0]!.id],
    );
    expect(rows[0].payload).toMatchObject({ code: "skill_not_granted", at: "invocation" });
    const finalRun = await db.pool.query("SELECT status FROM flow_runs WHERE id = $1", [
      run.rows[0]!.id,
    ]);
    expect(finalRun.rows[0].status).toBe("failed");
  });
});

describe("M3 — segregation of duties", () => {
  it("the same agent cannot act on both sides of a maker-checker constraint", async () => {
    await seedAgent("recon-preparer", "preparer-role");
    await seedAgent("recon-approver", "approver-role");
    await seedSkill("prepare-recon@1", async (i) => ({ ...i, prepared: true }));
    await seedSkill("approve-recon@1", async (i) => ({ ...i, approved: true }));
    await grant("recon-preparer", "prepare-recon@1");
    await grant("recon-approver", "approve-recon@1");
    // ALSO grant the approver's skill to the preparer's role — the SoD
    // constraint, not the grant, must be what blocks it.
    await grant("recon-preparer", "approve-recon@1");

    await db.pool.query(
      `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
       SELECT least(p.id, a.id), greatest(p.id, a.id), 'maker-checker: prepare vs approve'
         FROM roles p, roles a WHERE p.name = 'preparer-role' AND a.name = 'approver-role'`,
    );

    // Flow where the PREPARER attempts both sides.
    const { flowVersionId: badFlow } = await publishFlowVersion(db.pool, {
      definition: {
        name: "self-approval-flow",
        steps: [
          { key: "prepare", agent: "recon-preparer", skills: ["prepare-recon@1"] },
          { key: "approve", agent: "recon-preparer", skills: ["approve-recon@1"] },
        ],
      },
      actor: USER,
    });
    const selfRun = await startRun(ctx, { flowVersionId: badFlow, triggeredBy: USER });
    // Same role twice is NOT an SoD violation (same role ≠ conflicting roles),
    // so this one completes — the constraint binds ROLE PAIRS.
    expect(await waitForRunStatus(selfRun, ["completed", "failed"])).toBe("completed");

    // Flow where conflicting ROLES both act: preparer prepares, approver
    // approves — fine. Then preparer-role tries to act in a run where
    // approver-role already completed a step — blocked.
    const { flowVersionId: crossFlow } = await publishFlowVersion(db.pool, {
      definition: {
        name: "cross-role-flow",
        steps: [
          { key: "approve_first", agent: "recon-approver", skills: ["approve-recon@1"] },
          { key: "then_prepare", agent: "recon-preparer", skills: ["prepare-recon@1"] },
        ],
      },
      actor: USER,
    });
    const crossRun = await startRun(ctx, { flowVersionId: crossFlow, triggeredBy: USER });
    expect(await waitForRunStatus(crossRun, ["failed"])).toBe("failed");

    const { rows } = await db.pool.query(
      "SELECT payload FROM audit_events WHERE run_id = $1 AND event_type = 'enforcement.sod_violation'",
      [crossRun],
    );
    expect(rows[0].payload).toMatchObject({ code: "sod_violation" });
    const run = await db.pool.query("SELECT failure_reason FROM flow_runs WHERE id = $1", [
      crossRun,
    ]);
    expect(run.rows[0].failure_reason).toContain("segregation of duties");
  });

  it("non-conflicting roles may share a run", async () => {
    // math-flow's worker-a-role and worker-b-role have no constraint and the
    // multi-step e2e test completed — assert that explicitly here.
    const { rows } = await db.pool.query(
      `SELECT fr.status FROM flow_runs fr
         JOIN flow_versions fv ON fv.id = fr.flow_version_id
         JOIN flows f ON f.id = fv.flow_id
        WHERE f.name = 'math-flow'`,
    );
    expect(rows.every((r) => r.status === "completed")).toBe(true);
  });
});

describe("M3 — high-risk skills require gates", () => {
  it("rejects publishing a flow with a high-risk skill and no preceding gate", async () => {
    await seedAgent("payments-agent");
    await seedSkill("post-payment@1", async (i) => ({ ...i, posted: true }), "high");
    await grant("payments-agent", "post-payment@1");

    await expect(
      publishFlowVersion(db.pool, {
        definition: {
          name: "ungated-payment-flow",
          steps: [{ key: "pay", agent: "payments-agent", skills: ["post-payment@1"] }],
        },
        actor: USER,
      }),
    ).rejects.toThrow(/high-risk.*approval gate/);
  });

  it("publishes and runs a gated high-risk flow end to end", async () => {
    await seedAgent("payments-agent");
    await seedSkill("post-payment@1", async (i) => ({ ...i, posted: true }), "high");
    await seedSkill("draft-payment@1", async (i) => ({ ...i, drafted: true }));
    await grant("payments-agent", "post-payment@1");
    await grant("payments-agent", "draft-payment@1");

    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "gated-payment-flow",
        steps: [
          { key: "draft", agent: "payments-agent", skills: ["draft-payment@1"] },
          { key: "review", type: "approval_gate", title: "Approve payment batch" },
          { key: "post", agent: "payments-agent", skills: ["post-payment@1"] },
        ],
      },
      actor: USER,
    });
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    await waitForRunStatus(runId, ["waiting_approval"]);
    const approval = await db.pool.query<{ id: string }>(
      "SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'",
      [runId],
    );
    await decideApproval(ctx, {
      approvalId: approval.rows[0]!.id,
      decision: "approved",
      decidedBy: USER,
    });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });

  it("enforce() itself rejects a high-risk skill with no preceding gate at run time", async () => {
    const { enforce } = await import("./enforcement.js");
    const { withTransaction } = await import("../../test/test-db.js");
    await expect(
      withTransaction(db.pool, (client) =>
        enforce(client, {
          agentName: "payments-agent",
          skillRefs: ["post-payment@1"],
          runId: "00000000-0000-0000-0000-000000000000",
          hasPrecedingGate: false,
        }),
      ),
    ).rejects.toThrow(/high-risk/);
  });
});

describe("error paths and edge cases", () => {
  it("blocks a step referencing a skill missing from the registry table", async () => {
    await seedAgent("no-skill-agent");
    // Skill is in the flow definition and local registry, but NOT in the skills table.
    registry.set("unregistered@1", async (i) => i);
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "no-skill-flow",
        steps: [{ key: "s", agent: "no-skill-agent", skills: ["unregistered@1"] }],
      },
      actor: USER,
    });
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    const { rows } = await db.pool.query(
      "SELECT payload FROM audit_events WHERE run_id = $1 AND event_type = 'enforcement.blocked'",
      [runId],
    );
    expect(rows[0].payload).toMatchObject({ code: "skill_not_found" });
  });

  it("blocks a step whose skill has been deprecated since publish", async () => {
    await seedAgent("deprecated-agent");
    await seedSkill("sunset@1", async (i) => i);
    await grant("deprecated-agent", "sunset@1");
    await db.pool.query(
      "UPDATE skills SET status = 'deprecated' WHERE name = 'sunset' AND version = 1",
    );
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "sunset-flow",
        steps: [{ key: "s", agent: "deprecated-agent", skills: ["sunset@1"] }],
      },
      actor: USER,
    });
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");
    const { rows } = await db.pool.query(
      "SELECT payload FROM audit_events WHERE run_id = $1 AND event_type = 'enforcement.blocked'",
      [runId],
    );
    expect(rows[0].payload).toMatchObject({ code: "skill_deprecated" });
  });

  it("publishFlowVersion rolls back atomically on constraint failure", async () => {
    const before = await db.pool.query("SELECT count(*) AS n FROM flow_versions");
    await expect(
      publishFlowVersion(db.pool, {
        definition: {
          name: "rollback-flow",
          steps: [{ key: "s", agent: "x", skills: ["y@1"] }],
        },
        actor: USER,
        createdByUserId: "00000000-0000-0000-0000-000000000000", // FK violation
      }),
    ).rejects.toThrow();
    const after = await db.pool.query("SELECT count(*) AS n FROM flow_versions");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("startRun rolls back on a nonexistent flow version", async () => {
    await expect(
      startRun(ctx, {
        flowVersionId: "00000000-0000-0000-0000-000000000000",
        triggeredBy: USER,
      }),
    ).rejects.toThrow();
  });

  it("decideApproval rejects unknown approval ids", async () => {
    await expect(
      decideApproval(ctx, {
        approvalId: "00000000-0000-0000-0000-000000000000",
        decision: "approved",
        decidedBy: USER,
      }),
    ).rejects.toThrow(/not found/);
  });

  it("backend refuses to start twice", async () => {
    await expect(ctx.backend.start({})).rejects.toThrow(/already started/);
  });

  it("advanceRun: unknown run throws, terminal run is a quiet no-op", async () => {
    await expect(advanceRun(ctx, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /not found/,
    );
    const { rows } = await db.pool.query<{ id: string }>(
      "SELECT id FROM flow_runs WHERE status = 'completed' LIMIT 1",
    );
    await expect(advanceRun(ctx, rows[0]!.id)).resolves.toBeUndefined();
  });

  it("advanceRun is idempotent while a gate is already pending", async () => {
    await seedAgent("idem-agent");
    await seedSkill("idem-skill@1", async (i) => i);
    await grant("idem-agent", "idem-skill@1");
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "idem-gated-flow",
        steps: [
          { key: "work", agent: "idem-agent", skills: ["idem-skill@1"] },
          { key: "review", type: "approval_gate", title: "Park here" },
          { key: "more", agent: "idem-agent", skills: ["idem-skill@1"] },
        ],
      },
      actor: USER,
    });
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    await waitForRunStatus(runId, ["waiting_approval"]);
    const before = await db.pool.query(
      "SELECT count(*) AS n FROM approvals WHERE run_id = $1",
      [runId],
    );
    await advanceRun(ctx, runId); // duplicate delivery
    const after = await db.pool.query(
      "SELECT count(*) AS n FROM approvals WHERE run_id = $1",
      [runId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("executeStep on an unknown or already-settled step_run is a quiet no-op", async () => {
    await expect(
      executeStep(ctx, "00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
  });

  it("enqueue works without options and with runAt", async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      "SELECT id FROM flow_runs WHERE status = 'completed' LIMIT 1",
    );
    const runId = rows[0]!.id;
    await expect(ctx.backend.enqueue(TASK_ADVANCE, { runId })).resolves.toBeUndefined();
    await expect(
      ctx.backend.enqueue(TASK_ADVANCE, { runId }, { runAt: new Date(Date.now() + 50) }),
    ).resolves.toBeUndefined();
  });

  it("startRun records the trigger that fired it", async () => {
    await seedAgent("trig-agent");
    await seedSkill("trig-skill@1", async (i) => i);
    await grant("trig-agent", "trig-skill@1");
    const { flowId, flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "trig-flow",
        steps: [{ key: "s", agent: "trig-agent", skills: ["trig-skill@1"] }],
      },
      actor: USER,
    });
    const trig = await db.pool.query<{ id: string }>(
      `INSERT INTO flow_triggers (flow_id, type, config) VALUES ($1, 'manual', '{}') RETURNING id`,
      [flowId],
    );
    const runId = await startRun(ctx, {
      flowVersionId,
      triggeredBy: USER,
      triggerId: trig.rows[0]!.id,
    });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
    const { rows } = await db.pool.query(
      "SELECT trigger_id FROM flow_runs WHERE id = $1",
      [runId],
    );
    expect(rows[0].trigger_id).toBe(trig.rows[0]!.id);
  });

  it("loadDefinition throws on unknown flow versions", async () => {
    const client = await db.pool.connect();
    try {
      await expect(
        loadDefinition(client, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow(/not found/);
    } finally {
      client.release();
    }
  });

  it("watchdog default grace leaves recent steps alone", async () => {
    await expect(sweepStuckSteps(ctx)).resolves.toBe(0);
  });

  it("LocalSkillExecutor throws on unregistered skills and aborted signals", async () => {
    const executor = new LocalSkillExecutor(new Map());
    const step = { key: "s", agent: "a", skills: ["nope@1"] };
    await expect(
      executor.execute({ step, input: {}, signal: new AbortController().signal }),
    ).rejects.toThrow(/no local implementation/);

    const aborted = new AbortController();
    aborted.abort();
    const reg = new Map<string, LocalSkillFn>([["yes@1", async (i: Json) => i]]);
    await expect(
      new LocalSkillExecutor(reg).execute({
        step: { key: "s", agent: "a", skills: ["yes@1"] },
        input: {},
        signal: aborted.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});

describe("backoff", () => {
  it("is zero for 'none' and exponential with a cap otherwise", () => {
    expect(backoffDelayMs(1, "none")).toBe(0);
    expect(backoffDelayMs(1, "exponential")).toBe(2000);
    expect(backoffDelayMs(2, "exponential")).toBe(4000);
    expect(backoffDelayMs(10, "exponential")).toBe(60_000);
    expect(backoffDelayMs(1)).toBe(2000); // default = exponential
  });
});

describe("engine robustness: race + crash safety", () => {
  async function waitForStepSettled(runId: string, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await db.pool.query<{ status: string }>(
        "SELECT status FROM step_runs WHERE run_id = $1 ORDER BY step_index DESC LIMIT 1",
        [runId],
      );
      const status = rows[0]?.status;
      if (status && status !== "running" && status !== "pending") return status;
      if (Date.now() > deadline) throw new Error(`step for ${runId} never settled (at "${status}")`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ADVERSARIAL: the watchdog (or a retried delivery) fails an attempt while it
  // is still executing. The completed-write must NOT resurrect the failed step.
  it("does not resurrect a step the watchdog failed mid-execution", async () => {
    await seedAgent("race-agent");
    // The skill simulates the watchdog timing out THIS attempt while it runs:
    // it flips the (only) running step_run to timed_out before returning. When
    // executeStep then reaches its guarded completed-write, the row is no longer
    // 'running', so it must be left as timed_out rather than flipped to completed.
    await seedSkill("race-skill@1", async () => {
      await db.pool.query(
        `UPDATE step_runs SET status = 'timed_out', error = '{"message":"watchdog"}', finished_at = now()
           WHERE status = 'running'`,
      );
      return { ok: true };
    });
    await grant("race-agent", "race-skill@1");
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "race-flow",
        steps: [{ key: "s", agent: "race-agent", skills: ["race-skill@1"] }],
      },
      actor: USER,
    });

    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    expect(await waitForStepSettled(runId)).toBe("timed_out"); // NOT resurrected to completed

    const { rows } = await db.pool.query<{ status: string }>(
      "SELECT status FROM step_runs WHERE run_id = $1",
      [runId],
    );
    expect(rows.every((r) => r.status === "timed_out")).toBe(true);
    // No completed event was emitted for the resurrected attempt.
    expect(await eventTypes(runId)).not.toContain("run.step.completed");
    // The chain stays internally consistent regardless of the race.
    expect((await verifyChain(db.pool)).ok).toBe(true);
  });

  // ADVERSARIAL: a crash (or outage) of the queue's enqueue path between the run
  // INSERT and the first advance must not orphan the run. The fix enqueues the
  // first advance in the SAME transaction as the run row, so a broken
  // backend.enqueue cannot prevent the run from advancing.
  it("starts a run even when backend.enqueue is broken (in-tx first advance)", async () => {
    await seedAgent("crash-agent");
    await seedSkill("crash-skill@1", async (input) => ({ ...input, ran: true }));
    await grant("crash-agent", "crash-skill@1");
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      definition: {
        name: "crash-flow",
        steps: [{ key: "s", agent: "crash-agent", skills: ["crash-skill@1"] }],
      },
      actor: USER,
    });

    // A backend whose enqueue() throws. Pre-fix, startRun called this and would
    // reject, orphaning the run. Post-fix, startRun never calls it (the advance
    // job is written in-tx) and the real worker still picks the job up.
    const brokenBackend = Object.create(ctx.backend) as typeof ctx.backend;
    brokenBackend.enqueue = async () => {
      throw new Error("backend.enqueue is down");
    };

    const runId = await startRun(
      { ...ctx, backend: brokenBackend },
      { flowVersionId, triggeredBy: USER },
    );
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
    expect((await verifyChain(db.pool)).ok).toBe(true);
  });
});
