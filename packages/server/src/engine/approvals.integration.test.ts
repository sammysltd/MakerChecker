import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { buildApp } from "../app.js";
import { generateApiKey } from "../auth/api-keys.js";
import { verifyChain } from "../audit/verify.js";
import { GraphileWorkerBackend } from "./graphile-backend.js";
import { LocalSkillExecutor, type LocalSkillFn } from "./executor.js";
import { publishFlowVersion, FlowValidationError } from "./flows.js";
import {
  ApprovalDecisionError,
  createHandlers,
  decideApproval,
  startRun,
  type EngineContext,
} from "./orchestrator.js";

/**
 * n-of-m named approvals (M13). These tests attack every identity rule the
 * gates claim to enforce: requester self-approval, the same user voting
 * twice, users outside the named approver list, unauthenticated decisions —
 * and prove legacy single-approval gates are byte-for-byte unchanged.
 */

let db: TestDb;
let ctx: EngineContext;
let app: Awaited<ReturnType<typeof buildApp>>;
const registry = new Map<string, LocalSkillFn>();

const USER = { type: "user" as const, id: "test-user", name: "Test User" };

interface TestUser {
  id: string;
  email: string;
  auth: Record<string, string>;
}
const users: Record<string, TestUser> = {};

async function createUser(name: string, isAdmin = false): Promise<TestUser> {
  const email = `${name}@bank.example`;
  const row = await db.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, is_admin)
     VALUES ($1, 'x', $2, $3) RETURNING id`,
    [email, name, isAdmin],
  );
  const key = await generateApiKey(db.pool, { userId: row.rows[0]!.id, name: `${name}-key` });
  return {
    id: row.rows[0]!.id,
    email,
    auth: { authorization: `Bearer ${key.plaintext}` },
  };
}

beforeAll(async () => {
  db = await createTestDb();
  const backend = new GraphileWorkerBackend(db.pool, 5);
  ctx = { pool: db.pool, backend, executor: new LocalSkillExecutor(registry) };
  await backend.start(createHandlers(ctx));
  app = await buildApp(ctx);

  for (const name of ["alice", "bob", "carol", "dave"]) {
    users[name] = await createUser(name);
  }
  users.root = await createUser("root", true);

  await db.pool.query(
    `WITH role AS (INSERT INTO roles (name) VALUES ('nm-role') RETURNING id)
     INSERT INTO agents (name, role_id) SELECT 'nm-agent', id FROM role`,
  );
  for (const skill of ["nm-pre", "nm-post"]) {
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ($1, 1, '{}', '{}', '{"type":"local"}', 'low')`,
      [skill],
    );
    registry.set(`${skill}@1`, async (i) => ({ ...i, [skill]: true }));
    await db.pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT a.role_id, s.id FROM agents a, skills s
        WHERE a.name = 'nm-agent' AND s.name = $1 AND s.version = 1`,
      [skill],
    );
  }

  const gatedFlow = (name: string, approvals?: Record<string, unknown>) => ({
    name,
    steps: [
      { key: "pre", agent: "nm-agent", skills: ["nm-pre@1"] },
      {
        key: "gate",
        type: "approval_gate",
        title: `Gate of ${name}`,
        ...(approvals !== undefined ? { approvals } : {}),
      },
      { key: "post", agent: "nm-agent", skills: ["nm-post@1"] },
    ],
  });
  await publishFlowVersion(db.pool, {
    actor: USER,
    definition: gatedFlow("dual-flow", { min_approvals: 2 }),
  });
  await publishFlowVersion(db.pool, {
    actor: USER,
    definition: gatedFlow("named-flow", {
      min_approvals: 2,
      approver_emails: ["alice@bank.example", "bob@bank.example"],
    }),
  });
  await publishFlowVersion(db.pool, {
    actor: USER,
    definition: gatedFlow("legacy-flow"),
  });
  await publishFlowVersion(db.pool, {
    actor: USER,
    definition: gatedFlow("open-identity-flow", { forbid_requester: false }),
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await ctx.backend.stop();
  await db.drop();
});

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

/** Triggers a flow run via the API as the given user; returns runId + pending approval. */
async function triggerAndPark(
  flow: string,
  as: TestUser,
): Promise<{ runId: string; approvalId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/flows/${flow}/runs`,
    headers: as.auth,
    payload: { input: {} },
  });
  expect(res.statusCode).toBe(201);
  const runId = res.json().runId as string;
  await waitForRunStatus(runId, ["waiting_approval"]);
  const { rows } = await db.pool.query<{ id: string }>(
    "SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'",
    [runId],
  );
  return { runId, approvalId: rows[0]!.id };
}

async function decideVia(
  approvalId: string,
  as: TestUser,
  decision: "approved" | "rejected",
  reason?: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/approvals/${approvalId}/decision`,
    headers: as.auth,
    payload: { decision, ...(reason !== undefined ? { reason } : {}) },
  });
}

async function runEvents(runId: string): Promise<Array<{ event_type: string; payload: Record<string, unknown> }>> {
  const { rows } = await db.pool.query(
    "SELECT event_type, payload FROM audit_events WHERE run_id = $1 ORDER BY seq",
    [runId],
  );
  return rows;
}

describe("2-of-2 named approvals", () => {
  it("resolves only when two distinct users have approved", async () => {
    const { runId, approvalId } = await triggerAndPark("dual-flow", users.carol!);

    // Inbox surfaces the quorum.
    const inbox = (
      await app.inject({ method: "GET", url: "/api/approvals", headers: users.alice!.auth })
    ).json();
    expect(
      inbox.approvals.find((a: { id: string }) => a.id === approvalId),
    ).toMatchObject({ required_approvals: 2, approved_count: 0 });

    // First approval: recorded, gate still pending, run still parked.
    const first = await decideVia(approvalId, users.alice!, "approved", "checked the batch");
    expect(first.statusCode).toBe(200);
    const midApproval = await db.pool.query("SELECT status FROM approvals WHERE id = $1", [
      approvalId,
    ]);
    expect(midApproval.rows[0].status).toBe("pending");
    const midRun = await db.pool.query("SELECT status FROM flow_runs WHERE id = $1", [runId]);
    expect(midRun.rows[0].status).toBe("waiting_approval");

    // Second distinct approver reaches the quorum; the run resumes.
    const second = await decideVia(approvalId, users.bob!, "approved", "independent check");
    expect(second.statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");

    // Run detail: who decided what, when, and why.
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/runs/${runId}`,
        headers: users.alice!.auth,
      })
    ).json();
    expect(detail.approvals[0]).toMatchObject({ status: "approved", required_approvals: 2 });
    expect(detail.approvals[0].decisions).toMatchObject([
      { decided_by: "alice@bank.example", decision: "approved", reason: "checked the batch" },
      { decided_by: "bob@bank.example", decision: "approved", reason: "independent check" },
    ]);

    // Audit chain: a decided event per decision (with the running tally) and
    // one resolution event.
    const events = await runEvents(runId);
    const decided = events.filter((e) => e.event_type === "approval.decided");
    expect(decided.map((e) => e.payload.approvedCount)).toEqual([1, 2]);
    const resolved = events.filter((e) => e.event_type === "approval.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload).toMatchObject({ outcome: "approved", requiredApprovals: 2 });
  });

  it("blocks the run's requester from deciding (forbid_requester defaults on)", async () => {
    const { runId, approvalId } = await triggerAndPark("dual-flow", users.carol!);

    const res = await decideVia(approvalId, users.carol!, "approved");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("triggered this run");

    const events = await runEvents(runId);
    const denied = events.filter((e) => e.event_type === "approval.decision_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({ code: "requester_forbidden" });
    // Nothing was recorded as a decision; the gate is untouched.
    const decisions = await db.pool.query(
      "SELECT count(*)::int AS n FROM approval_decisions WHERE approval_id = $1",
      [approvalId],
    );
    expect(decisions.rows[0].n).toBe(0);
  });

  it("refuses the same user deciding twice (409)", async () => {
    const { approvalId } = await triggerAndPark("dual-flow", users.carol!);

    expect((await decideVia(approvalId, users.alice!, "approved")).statusCode).toBe(200);
    const again = await decideVia(approvalId, users.alice!, "approved");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain("cannot decide twice");

    const decisions = await db.pool.query(
      "SELECT count(*)::int AS n FROM approval_decisions WHERE approval_id = $1",
      [approvalId],
    );
    expect(decisions.rows[0].n).toBe(1);
  });

  it("a single rejection resolves the gate and fails the run immediately", async () => {
    const { runId, approvalId } = await triggerAndPark("dual-flow", users.carol!);

    const res = await decideVia(approvalId, users.bob!, "rejected", "numbers do not reconcile");
    expect(res.statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["failed"])).toBe("failed");

    const approval = await db.pool.query("SELECT status FROM approvals WHERE id = $1", [
      approvalId,
    ]);
    expect(approval.rows[0].status).toBe("rejected");
    const run = await db.pool.query("SELECT failure_reason FROM flow_runs WHERE id = $1", [
      runId,
    ]);
    expect(run.rows[0].failure_reason).toContain("rejected");
    const events = await runEvents(runId);
    const resolved = events.find((e) => e.event_type === "approval.resolved");
    expect(resolved!.payload).toMatchObject({ outcome: "rejected", rejectedCount: 1 });
  });

  it("rejects unauthenticated decisions on identity gates (fail closed)", async () => {
    const { runId, approvalId } = await triggerAndPark("dual-flow", users.carol!);

    await expect(
      decideApproval(ctx, {
        approvalId,
        decision: "approved",
        decidedBy: { type: "user", name: "api" }, // no authenticated user
      }),
    ).rejects.toThrow(/requires an authenticated decision/);

    const events = await runEvents(runId);
    const denied = events.find((e) => e.event_type === "approval.decision_denied");
    expect(denied!.payload).toMatchObject({ code: "unauthenticated" });
    try {
      await decideApproval(ctx, {
        approvalId,
        decision: "approved",
        decidedBy: { type: "user", name: "api" },
      });
      expect.unreachable("decision should have been denied");
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalDecisionError);
      expect((err as ApprovalDecisionError).statusCode).toBe(403);
    }
  });
});

describe("approver_emails — named approver lists", () => {
  it("denies users outside the list and resolves with the named ones", async () => {
    const { runId, approvalId } = await triggerAndPark("named-flow", users.carol!);

    const outsider = await decideVia(approvalId, users.dave!, "approved");
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().error).toContain("not a named approver");
    const events = await runEvents(runId);
    expect(
      events.find((e) => e.event_type === "approval.decision_denied")!.payload,
    ).toMatchObject({ code: "not_named_approver" });

    expect((await decideVia(approvalId, users.alice!, "approved")).statusCode).toBe(200);
    expect((await decideVia(approvalId, users.bob!, "approved")).statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });

  it("publish-time validation rejects an unsatisfiable quorum", async () => {
    await expect(
      publishFlowVersion(db.pool, {
        actor: USER,
        definition: {
          name: "impossible-quorum",
          steps: [
            { key: "pre", agent: "nm-agent", skills: ["nm-pre@1"] },
            {
              key: "gate",
              type: "approval_gate",
              title: "Impossible",
              approvals: { min_approvals: 3, approver_emails: ["a@b.co", "c@d.co"] },
            },
            { key: "post", agent: "nm-agent", skills: ["nm-post@1"] },
          ],
        },
      }),
    ).rejects.toThrow(FlowValidationError);
  });
});

describe("legacy and explicitly-open gates", () => {
  it("gates without an approvals object behave exactly as before", async () => {
    const { runId, approvalId } = await triggerAndPark("legacy-flow", users.carol!);

    // Even the requester may decide — no identity rules apply.
    const res = await decideVia(approvalId, users.carol!, "approved", "looks fine");
    expect(res.statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");

    const events = await runEvents(runId);
    expect(events.some((e) => e.event_type === "approval.decided")).toBe(true);
    // No n-of-m settlement record for legacy gates.
    expect(events.some((e) => e.event_type === "approval.resolved")).toBe(false);
    // The decision ledger still has the single decision.
    const detail = (
      await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: users.carol!.auth })
    ).json();
    expect(detail.approvals[0].decisions).toMatchObject([
      { decided_by: "carol@bank.example", decision: "approved" },
    ]);
  });

  it("approvals with forbid_requester:false and quorum 1 allow unauthenticated decisions", async () => {
    const runId = await (async () => {
      const { rows } = await db.pool.query<{ id: string }>(
        `SELECT fv.id FROM flow_versions fv JOIN flows f ON f.id = fv.flow_id
          WHERE f.name = 'open-identity-flow' ORDER BY fv.version DESC LIMIT 1`,
      );
      return startRun(ctx, { flowVersionId: rows[0]!.id, triggeredBy: USER, runInput: {} });
    })();
    await waitForRunStatus(runId, ["waiting_approval"]);
    const approval = await db.pool.query<{ id: string }>(
      "SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'",
      [runId],
    );

    // None of the identity conditions apply: quorum 1, no emails, requester allowed.
    await decideApproval(ctx, {
      approvalId: approval.rows[0]!.id,
      decision: "approved",
      decidedBy: { type: "user", name: "api" },
    });
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
    // The approvals object is present, so the settlement record IS emitted.
    const events = await runEvents(runId);
    expect(events.some((e) => e.event_type === "approval.resolved")).toBe(true);
  });

  it("the audit chain verifies after every adversarial path above", async () => {
    expect((await verifyChain(db.pool)).ok).toBe(true);
  });
});

describe("strict-SoD mode binds the requester on every gate, however authored", () => {
  afterEach(() => {
    delete process.env.MAKERCHECKER_REQUIRE_IDENTITY_GATES;
  });

  it("denies the run's requester on a legacy gate with an audited denial", async () => {
    const { runId, approvalId } = await triggerAndPark("legacy-flow", users.carol!);
    process.env.MAKERCHECKER_REQUIRE_IDENTITY_GATES = "1";

    const res = await decideVia(approvalId, users.carol!, "approved");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("triggered this run");

    const denied = (await runEvents(runId)).filter(
      (e) => e.event_type === "approval.decision_denied",
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({ code: "requester_forbidden" });
    const decisions = await db.pool.query(
      "SELECT count(*)::int AS n FROM approval_decisions WHERE approval_id = $1",
      [approvalId],
    );
    expect(decisions.rows[0].n).toBe(0);
  });

  it("denies an ADMIN requester on a legacy gate identically", async () => {
    const { runId, approvalId } = await triggerAndPark("legacy-flow", users.root!);
    process.env.MAKERCHECKER_REQUIRE_IDENTITY_GATES = "1";

    const res = await decideVia(approvalId, users.root!, "approved");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("triggered this run");

    const denied = (await runEvents(runId)).filter(
      (e) => e.event_type === "approval.decision_denied",
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({ code: "requester_forbidden" });
    const decisions = await db.pool.query(
      "SELECT count(*)::int AS n FROM approval_decisions WHERE approval_id = $1",
      [approvalId],
    );
    expect(decisions.rows[0].n).toBe(0);
  });

  it("denies an unauthenticated decision on a legacy gate (fail closed)", async () => {
    const { runId, approvalId } = await triggerAndPark("legacy-flow", users.carol!);
    process.env.MAKERCHECKER_REQUIRE_IDENTITY_GATES = "1";

    await expect(
      decideApproval(ctx, {
        approvalId,
        decision: "approved",
        decidedBy: { type: "user", name: "api" },
      }),
    ).rejects.toThrow(/requires an authenticated decision/);
    const denied = (await runEvents(runId)).find(
      (e) => e.event_type === "approval.decision_denied",
    );
    expect(denied!.payload).toMatchObject({ code: "unauthenticated" });
  });

  it("denies the requester on a gate that explicitly set forbid_requester:false", async () => {
    const { runId, approvalId } = await triggerAndPark("open-identity-flow", users.carol!);
    process.env.MAKERCHECKER_REQUIRE_IDENTITY_GATES = "1";

    const res = await decideVia(approvalId, users.carol!, "approved");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("triggered this run");

    const denied = (await runEvents(runId)).filter(
      (e) => e.event_type === "approval.decision_denied",
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({ code: "requester_forbidden" });
    const decisions = await db.pool.query(
      "SELECT count(*)::int AS n FROM approval_decisions WHERE approval_id = $1",
      [approvalId],
    );
    expect(decisions.rows[0].n).toBe(0);
  });

  it("denies an unauthenticated decision on a forbid_requester:false gate", async () => {
    const { runId, approvalId } = await triggerAndPark("open-identity-flow", users.carol!);
    process.env.MAKERCHECKER_REQUIRE_IDENTITY_GATES = "1";

    await expect(
      decideApproval(ctx, {
        approvalId,
        decision: "approved",
        decidedBy: { type: "user", name: "api" },
      }),
    ).rejects.toThrow(/requires an authenticated decision/);
    const denied = (await runEvents(runId)).find(
      (e) => e.event_type === "approval.decision_denied",
    );
    expect(denied!.payload).toMatchObject({ code: "unauthenticated" });
  });

  it("lets a non-requester clear the same legacy gate in strict mode", async () => {
    const { runId, approvalId } = await triggerAndPark("legacy-flow", users.carol!);
    process.env.MAKERCHECKER_REQUIRE_IDENTITY_GATES = "1";

    const res = await decideVia(approvalId, users.bob!, "approved");
    expect(res.statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });

  it("with strict mode OFF the requester may still decide the legacy gate", async () => {
    const { runId, approvalId } = await triggerAndPark("legacy-flow", users.carol!);

    const res = await decideVia(approvalId, users.carol!, "approved");
    expect(res.statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });
});
