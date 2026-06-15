import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { buildApp } from "../app.js";
import { generateApiKey } from "../auth/api-keys.js";
import { verifyChain } from "../audit/verify.js";
import { GraphileWorkerBackend } from "../engine/graphile-backend.js";
import { LocalSkillExecutor, type LocalSkillFn } from "../engine/executor.js";
import { publishFlowVersion } from "../engine/flows.js";
import { createHandlers, startRun, type EngineContext } from "../engine/orchestrator.js";

/**
 * TASK D — the authorization layer (red-team regressions). is_admin was loaded
 * into req.authUser but never enforced. These tests attack the three holes:
 *
 *  1. Admin gating — a non-admin key is 403'd on every admin CRUD route, while
 *     an admin key (and AUTH_DISABLED mode) is admitted.
 *  2. Approval-decision authz — an unrelated key cannot decide an ungoverned
 *     (legacy) gate, but a participant (the run's requester) can, since an
 *     ungoverned gate applies no n-of-m identity rule; named-list and
 *     identity-mode gates defer to the orchestrator (which audits its denials).
 *  3. Object-level reads — a non-admin cannot read another actor's run,
 *     approval inbox entry, or proxy session; the owner and admins can.
 *
 * Deny by default everywhere: cross-actor reads return the same 404 a missing
 * object does, so existence never leaks.
 */

let db: TestDb;
let ctx: EngineContext;
let app: Awaited<ReturnType<typeof buildApp>>;
const registry = new Map<string, LocalSkillFn>();

const SYSTEM = { type: "user" as const, id: "sys", name: "system" };

interface TestUser {
  id: string;
  email: string;
  isAdmin: boolean;
  auth: Record<string, string>;
}
const users: Record<string, TestUser> = {};

async function createUser(name: string, isAdmin: boolean): Promise<TestUser> {
  const email = `${name}@bank.example`;
  const row = await db.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, is_admin)
     VALUES ($1, 'x', $2, $3) RETURNING id`,
    [email, name, isAdmin],
  );
  const key = await generateApiKey(db.pool, { userId: row.rows[0]!.id, name: `${name}-key` });
  return { id: row.rows[0]!.id, email, isAdmin, auth: { authorization: `Bearer ${key.plaintext}` } };
}

async function publishedFlowVersionId(name: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT fv.id FROM flow_versions fv JOIN flows f ON f.id = fv.flow_id
      WHERE f.name = $1 ORDER BY fv.version DESC LIMIT 1`,
    [name],
  );
  return rows[0]!.id;
}

async function waitForRunStatus(runId: string, statuses: string[], timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.pool.query<{ status: string }>(
      "SELECT status FROM flow_runs WHERE id = $1",
      [runId],
    );
    const status = rows[0]!.status;
    if (statuses.includes(status)) return status;
    if (Date.now() > deadline) throw new Error(`run ${runId} stuck at "${status}"`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Starts a gated run as `triggeredBy`, parks at the gate, returns ids. */
async function startGatedRun(
  flow: string,
  triggeredBy: { type: "user"; id: string; name: string },
): Promise<{ runId: string; approvalId: string }> {
  const runId = await startRun(ctx, {
    flowVersionId: await publishedFlowVersionId(flow),
    triggeredBy,
    runInput: {},
  });
  await waitForRunStatus(runId, ["waiting_approval"]);
  const { rows } = await db.pool.query<{ id: string }>(
    "SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'",
    [runId],
  );
  return { runId, approvalId: rows[0]!.id };
}

async function decide(
  approvalId: string,
  as: TestUser,
  decision: "approved" | "rejected" = "approved",
) {
  return app.inject({
    method: "POST",
    url: `/api/approvals/${approvalId}/decision`,
    headers: as.auth,
    payload: { decision },
  });
}

beforeAll(async () => {
  db = await createTestDb();
  const backend = new GraphileWorkerBackend(db.pool, 5);
  ctx = { pool: db.pool, backend, executor: new LocalSkillExecutor(registry) };
  await backend.start(createHandlers(ctx));
  app = await buildApp(ctx);

  users.admin = await createUser("admin", true);
  users.alice = await createUser("alice", false); // non-admin, named approver
  users.bob = await createUser("bob", false); // non-admin, named approver
  users.mallory = await createUser("mallory", false); // non-admin attacker
  users.requester = await createUser("requester", false); // non-admin run owner

  // Minimal agent + skill registry so gated flows can complete after approval.
  await db.pool.query(
    `WITH role AS (INSERT INTO roles (name) VALUES ('authz-role') RETURNING id)
     INSERT INTO agents (name, role_id) SELECT 'authz-agent', id FROM role`,
  );
  for (const skill of ["az-pre", "az-post"]) {
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ($1, 1, '{}', '{}', '{"type":"local"}', 'low')`,
      [skill],
    );
    registry.set(`${skill}@1`, async (i) => ({ ...i, [skill]: true }));
    await db.pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT a.role_id, s.id FROM agents a, skills s
        WHERE a.name = 'authz-agent' AND s.name = $1 AND s.version = 1`,
      [skill],
    );
  }

  const gated = (name: string, approvals?: Record<string, unknown>) => ({
    name,
    steps: [
      { key: "pre", agent: "authz-agent", skills: ["az-pre@1"] },
      {
        key: "gate",
        type: "approval_gate",
        title: `Gate of ${name}`,
        ...(approvals !== undefined ? { approvals } : {}),
      },
      { key: "post", agent: "authz-agent", skills: ["az-post@1"] },
    ],
  });

  // Flows are admin-authored here directly (the API path is covered by the
  // admin-gating tests below) so the authz tests can focus on decisions/reads.
  await publishFlowVersion(db.pool, { actor: SYSTEM, definition: gated("legacy-gate") });
  await publishFlowVersion(db.pool, {
    actor: SYSTEM,
    definition: gated("identity-gate", { min_approvals: 1, forbid_requester: false }),
  });
  await publishFlowVersion(db.pool, {
    actor: SYSTEM,
    definition: gated("named-gate", {
      min_approvals: 1,
      approver_emails: ["alice@bank.example", "bob@bank.example"],
    }),
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await ctx.backend.stop();
  await db.drop();
});

// ---------------------------------------------------------------- 1. admin gating

describe("admin gating on CRUD routes", () => {
  // Every mutating admin route, with a body valid enough to reach the handler.
  const routes: Array<{
    method: "POST" | "PATCH" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }> = [
    { method: "POST", url: "/api/roles", payload: { name: "x-role" } },
    { method: "DELETE", url: "/api/roles/00000000-0000-0000-0000-000000000000" },
    {
      method: "POST",
      url: "/api/sod-constraints",
      payload: {
        roleAId: "00000000-0000-0000-0000-000000000001",
        roleBId: "00000000-0000-0000-0000-000000000002",
      },
    },
    { method: "POST", url: "/api/sod-constraints/00000000-0000-0000-0000-000000000000/revoke" },
    {
      method: "POST",
      url: "/api/skills",
      payload: {
        name: "x-skill",
        version: 1,
        description: "d",
        inputSchema: {},
        outputSchema: {},
        implementation: { type: "local" },
        riskTier: "low",
      },
    },
    { method: "POST", url: "/api/skills/00000000-0000-0000-0000-000000000000/deprecate" },
    { method: "PATCH", url: "/api/skills/00000000-0000-0000-0000-000000000000", payload: {} },
    {
      method: "POST",
      url: "/api/grants",
      payload: {
        roleId: "00000000-0000-0000-0000-000000000001",
        skillId: "00000000-0000-0000-0000-000000000002",
      },
    },
    { method: "POST", url: "/api/grants/00000000-0000-0000-0000-000000000000/revoke" },
    { method: "POST", url: "/api/agents", payload: { name: "x-agent", roleName: "authz-role" } },
    {
      method: "PATCH",
      url: "/api/agents/00000000-0000-0000-0000-000000000000",
      payload: { description: "x" },
    },
    {
      method: "POST",
      url: "/api/agents/00000000-0000-0000-0000-000000000000/status",
      payload: { status: "suspended" },
    },
    {
      method: "POST",
      url: "/api/flows",
      payload: { definition: { name: "x-flow", steps: [] } },
    },
    {
      method: "POST",
      url: "/api/triggers",
      payload: { flowName: "legacy-gate", type: "manual" },
    },
    {
      method: "PATCH",
      url: "/api/triggers/00000000-0000-0000-0000-000000000000",
      payload: { enabled: false },
    },
    {
      method: "POST",
      url: "/api/webhook-endpoints",
      payload: { url: "https://h.test/x", secret: "longenoughsecret" },
    },
  ];

  it.each(routes)("403s a non-admin key on $method $url", async ({ method, url, payload }) => {
    const res = await app.inject({
      method,
      url,
      headers: users.mallory!.auth,
      ...(payload !== undefined ? { payload } : {}),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("admin privileges required");
  });

  it("admits an admin key (status is NOT 403) on the same routes", async () => {
    for (const { method, url, payload } of routes) {
      const res = await app.inject({
        method,
        url,
        headers: users.admin!.auth,
        ...(payload !== undefined ? { payload } : {}),
      });
      // The route may 201/200/400/404/405 depending on the body, but never 403.
      expect(res.statusCode).not.toBe(403);
    }
  });

  it("does not gate plain registry GET routes for a non-admin (read access is allowed)", async () => {
    for (const url of ["/api/roles", "/api/skills", "/api/agents", "/api/flows", "/api/triggers"]) {
      const res = await app.inject({ method: "GET", url, headers: users.mallory!.auth });
      expect(res.statusCode).toBe(200);
    }
  });

  it("403s a non-admin on access-review (RBAC posture + admin emails are admin-only)", async () => {
    const denied = await app.inject({
      method: "GET",
      url: "/api/reports/access-review",
      headers: users.mallory!.auth,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toContain("admin privileges required");
    const ok = await app.inject({
      method: "GET",
      url: "/api/reports/access-review",
      headers: users.admin!.auth,
    });
    expect(ok.statusCode).toBe(200);
  });

  it("leaves audit/verify readable by a non-admin (intentional org-wide integrity signal)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/audit/verify",
      headers: users.mallory!.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("bypasses admin gating in MAKERCHECKER_AUTH_DISABLED mode", async () => {
    process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/roles",
        payload: { name: "noauth-role-authz" },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      delete process.env.MAKERCHECKER_AUTH_DISABLED;
    }
  });
});

// ----------------------------------------------------- 2. approval-decision authz

describe("approval-decision authorization (deny by default)", () => {
  const requesterActor = () => ({ type: "user" as const, id: users.requester!.id, name: users.requester!.email });

  it("403s an unrelated non-admin deciding an ungoverned (legacy) gate", async () => {
    const { approvalId } = await startGatedRun("legacy-gate", requesterActor());
    // mallory neither triggered the run nor is a named approver: not party to it.
    const res = await decide(approvalId, users.mallory!);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("not authorized");
    // Nothing was recorded as a decision; the gate is untouched.
    const decisions = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM approval_decisions WHERE approval_id = $1",
      [approvalId],
    );
    expect(decisions.rows[0]!.n).toBe(0);
  });

  it("lets the run's own requester decide a legacy gate (ungoverned: no self-approval rule)", async () => {
    const { runId, approvalId } = await startGatedRun("legacy-gate", requesterActor());
    // The requester is party to the run; an ungoverned gate has no forbid_requester.
    const res = await decide(approvalId, users.requester!);
    expect(res.statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });

  it("lets an admin decide a legacy gate and resume the run", async () => {
    const { runId, approvalId } = await startGatedRun("legacy-gate", requesterActor());
    const res = await decide(approvalId, users.admin!);
    expect(res.statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });

  it("defers identity-mode (no-list) gates to the orchestrator: a non-admin may decide", async () => {
    const { runId, approvalId } = await startGatedRun("identity-gate", requesterActor());
    const res = await decide(approvalId, users.mallory!);
    expect(res.statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });

  it("defers named-list gates to the orchestrator, which audits the denial", async () => {
    const { runId, approvalId } = await startGatedRun("named-gate", requesterActor());

    // Non-listed non-admin: orchestrator denies AND records decision_denied.
    const outsider = await decide(approvalId, users.mallory!);
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().error).toContain("not a named approver");
    const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events
        WHERE run_id = $1 AND event_type = 'approval.decision_denied'`,
      [runId],
    );
    expect(rows[0]!.payload).toMatchObject({ code: "not_named_approver" });

    // A named non-admin approver decides and the run resumes.
    const named = await decide(approvalId, users.alice!);
    expect(named.statusCode).toBe(200);
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
  });

  it("400s a malformed decision before any authz lookup", async () => {
    const { approvalId } = await startGatedRun("legacy-gate", requesterActor());
    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decision`,
      headers: users.admin!.auth,
      payload: { decision: "maybe" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// --------------------------------------------------------- 3. object-level reads

describe("object-level read scoping", () => {
  let ownedRunId: string;

  beforeAll(async () => {
    // A run triggered by `requester` (a non-admin).
    ownedRunId = await startRun(ctx, {
      flowVersionId: await publishedFlowVersionId("named-gate"),
      triggeredBy: { type: "user", id: users.requester!.id, name: users.requester!.email },
      runInput: {},
    });
    await waitForRunStatus(ownedRunId, ["waiting_approval"]);
  });

  it("404s a non-admin reading another actor's run (no existence leak)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${ownedRunId}`,
      headers: users.mallory!.auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("run not found");
  });

  it("lets the triggering actor read their own run", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${ownedRunId}`,
      headers: users.requester!.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.id).toBe(ownedRunId);
  });

  it("lets a named approver read a run they can act on", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${ownedRunId}`,
      headers: users.alice!.auth, // listed approver on named-gate
    });
    expect(res.statusCode).toBe(200);
  });

  it("lets an admin read any run", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${ownedRunId}`,
      headers: users.admin!.auth,
    });
    expect(res.statusCode).toBe(200);
  });

  it("scopes the approval inbox: requester and named approver see it, attacker does not", async () => {
    const inboxOf = async (as: TestUser) =>
      (await app.inject({ method: "GET", url: "/api/approvals", headers: as.auth })).json()
        .approvals as Array<{ run_id: string }>;

    expect((await inboxOf(users.requester!)).some((a) => a.run_id === ownedRunId)).toBe(true);
    expect((await inboxOf(users.alice!)).some((a) => a.run_id === ownedRunId)).toBe(true);
    expect((await inboxOf(users.mallory!)).some((a) => a.run_id === ownedRunId)).toBe(false);
    expect((await inboxOf(users.admin!)).some((a) => a.run_id === ownedRunId)).toBe(true);
  });

  it("inbox distinguishes open-pool (visible to all) from legacy gates (party-only)", async () => {
    const inboxRunIds = async (as: TestUser) =>
      ((await app.inject({ method: "GET", url: "/api/approvals", headers: as.auth })).json()
        .approvals as Array<{ run_id: string }>).map((a) => a.run_id);
    const requester = { type: "user" as const, id: users.requester!.id, name: users.requester!.email };

    // An identity-mode OPEN-POOL gate (no approver list) is decidable by any
    // non-requester, so it is correctly visible to an unrelated non-admin.
    const open = await startGatedRun("identity-gate", requester);
    expect(await inboxRunIds(users.mallory!)).toContain(open.runId);

    // A LEGACY gate (no `approvals` object) is decidable ONLY by a run
    // participant, so it must NOT leak to an unrelated non-admin — only the
    // requester (and admins) see it. This matches authorizeDecision's split.
    const legacy = await startGatedRun("legacy-gate", requester);
    expect(await inboxRunIds(users.requester!)).toContain(legacy.runId);
    expect(await inboxRunIds(users.admin!)).toContain(legacy.runId);
    expect(await inboxRunIds(users.mallory!)).not.toContain(legacy.runId);
  });

  it("scopes the run LIST: requester and named approver see it, attacker does not (no cross-actor leak)", async () => {
    const runsOf = async (as: TestUser) =>
      (await app.inject({ method: "GET", url: "/api/runs", headers: as.auth })).json()
        .runs as Array<{ id: string }>;

    expect((await runsOf(users.requester!)).some((r) => r.id === ownedRunId)).toBe(true);
    expect((await runsOf(users.alice!)).some((r) => r.id === ownedRunId)).toBe(true); // named approver
    expect((await runsOf(users.mallory!)).some((r) => r.id === ownedRunId)).toBe(false); // attacker
    expect((await runsOf(users.admin!)).some((r) => r.id === ownedRunId)).toBe(true);
  });

  it("scopes proxy-session reads to the creating actor (404 for others)", async () => {
    const opened = await app.inject({
      method: "POST",
      url: "/api/proxy/sessions",
      headers: users.requester!.auth,
      payload: { label: "owned-session" },
    });
    expect(opened.statusCode).toBe(201);
    const sessionId = opened.json().session.id as string;

    // Owner reads it.
    const owner = await app.inject({
      method: "GET",
      url: `/api/proxy/sessions/${sessionId}`,
      headers: users.requester!.auth,
    });
    expect(owner.statusCode).toBe(200);

    // Attacker is denied with the same 404 a missing session returns.
    const attacker = await app.inject({
      method: "GET",
      url: `/api/proxy/sessions/${sessionId}`,
      headers: users.mallory!.auth,
    });
    expect(attacker.statusCode).toBe(404);
    expect(attacker.json().error).toContain("proxy session not found");

    // Admin reads any session.
    const admin = await app.inject({
      method: "GET",
      url: `/api/proxy/sessions/${sessionId}`,
      headers: users.admin!.auth,
    });
    expect(admin.statusCode).toBe(200);
  });

  it("hides skill implementation config (possible secrets) from a non-admin on GET /skills/:id", async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('secretful-skill', 1, '{}', '{}', $1, 'low') RETURNING id`,
      [
        JSON.stringify({
          type: "http",
          url: "https://api.test/x",
          headers: { "x-api-key": "SUPERSECRET-TOKEN" },
        }),
      ],
    );
    const id = rows[0]!.id;

    // Non-admin: implementation reduced to its type discriminator, no secret.
    const asMallory = (
      await app.inject({ method: "GET", url: `/api/skills/${id}`, headers: users.mallory!.auth })
    ).json();
    expect(asMallory.skill.implementation).toEqual({ type: "http" });
    expect(JSON.stringify(asMallory)).not.toContain("SUPERSECRET-TOKEN");

    // Admin: full implementation, including the auth header.
    const asAdmin = (
      await app.inject({ method: "GET", url: `/api/skills/${id}`, headers: users.admin!.auth })
    ).json();
    expect(asAdmin.skill.implementation).toMatchObject({
      type: "http",
      headers: { "x-api-key": "SUPERSECRET-TOKEN" },
    });
  });

  it("hides agent recentRuns (cross-actor run enumeration) from a non-admin", async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      "SELECT id FROM agents WHERE name = 'authz-agent'",
    );
    const agentId = rows[0]!.id;

    // Admin sees the agent's recent runs (run-instance metadata).
    const asAdmin = (
      await app.inject({ method: "GET", url: `/api/agents/${agentId}`, headers: users.admin!.auth })
    ).json();
    expect(asAdmin.recentRuns.length).toBeGreaterThan(0);

    // A non-admin gets the agent config but NO run enumeration.
    const asMallory = (
      await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}`,
        headers: users.mallory!.auth,
      })
    ).json();
    expect(asMallory.agent.name).toBe("authz-agent"); // config still readable
    expect(asMallory.recentRuns).toEqual([]); // run instances are not
  });

  it("masks gate approver_emails (named human PII) from a non-admin on GET /flows/:name", async () => {
    // named-gate's definition carries approver_emails = [alice, bob] (set up in
    // the top-level beforeAll). Those are named human identities (PII) that no
    // non-admin needs to read a flow's structure.
    const emails = ["alice@bank.example", "bob@bank.example"];

    // Non-admin: the gate's structure/title survives but the email list is gone.
    const asMallory = (
      await app.inject({ method: "GET", url: "/api/flows/named-gate", headers: users.mallory!.auth })
    ).json();
    const maskedGate = (asMallory.versions[0].definition.steps as Array<Record<string, unknown>>).find(
      (s) => s.key === "gate",
    )!;
    expect(maskedGate.title).toBe("Gate of named-gate"); // structure intact
    expect((maskedGate.approvals as Record<string, unknown>).min_approvals).toBe(1); // config intact
    expect((maskedGate.approvals as Record<string, unknown>).approver_emails).toBeUndefined();
    // No approver email leaks anywhere in the response (not even the count).
    for (const email of emails) expect(JSON.stringify(asMallory)).not.toContain(email);

    // The run's own requester is still a non-admin: same masking applies.
    const asRequester = (
      await app.inject({ method: "GET", url: "/api/flows/named-gate", headers: users.requester!.auth })
    ).json();
    for (const email of emails) expect(JSON.stringify(asRequester)).not.toContain(email);

    // Admin: full definition, approver_emails present and exact.
    const asAdmin = (
      await app.inject({ method: "GET", url: "/api/flows/named-gate", headers: users.admin!.auth })
    ).json();
    const adminGate = (asAdmin.versions[0].definition.steps as Array<Record<string, unknown>>).find(
      (s) => s.key === "gate",
    )!;
    expect((adminGate.approvals as Record<string, unknown>).approver_emails).toEqual(emails);

    // Auth-disabled mode is an operator opt-out: the full list is returned.
    process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    try {
      const asOpen = (
        await app.inject({ method: "GET", url: "/api/flows/named-gate" })
      ).json();
      const openGate = (asOpen.versions[0].definition.steps as Array<Record<string, unknown>>).find(
        (s) => s.key === "gate",
      )!;
      expect((openGate.approvals as Record<string, unknown>).approver_emails).toEqual(emails);
    } finally {
      delete process.env.MAKERCHECKER_AUTH_DISABLED;
    }
  });

  it("does not change the STORED definition: masking is read-path only", async () => {
    // The at-rest row keeps the full approver list; only the response was shaped.
    const { rows } = await db.pool.query<{ definition: { steps: Array<Record<string, unknown>> } }>(
      `SELECT fv.definition FROM flow_versions fv
         JOIN flows f ON f.id = fv.flow_id
        WHERE f.name = 'named-gate' ORDER BY fv.version DESC LIMIT 1`,
    );
    const gate = rows[0]!.definition.steps.find((s) => s.key === "gate")!;
    expect((gate.approvals as Record<string, unknown>).approver_emails).toEqual([
      "alice@bank.example",
      "bob@bank.example",
    ]);
  });

  it("the audit chain still verifies after every adversarial path", async () => {
    expect((await verifyChain(db.pool)).ok).toBe(true);
  });
});
