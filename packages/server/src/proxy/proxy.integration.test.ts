import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { buildApp } from "../app.js";
import { checkAndAuthorize } from "./service.js";
import { generateApiKey, type GeneratedApiKey } from "../auth/api-keys.js";
import { GraphileWorkerBackend } from "../engine/graphile-backend.js";
import { LocalSkillExecutor } from "../engine/executor.js";
import type { EngineContext } from "../engine/orchestrator.js";

/**
 * Proxy sessions: the governance middleware for externally-orchestrated
 * agents. These tests attack every checkpoint the proxy claims to enforce —
 * ungranted skills, revoked grants, SoD across a session, high-risk skills,
 * suspended agents, closed sessions — because an unattacked guarantee is not
 * a guarantee.
 */

let db: TestDb;
let ctx: EngineContext;
let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
let key: GeneratedApiKey;
let auth: Record<string, string>;

const ZERO = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  db = await createTestDb();
  const user = await db.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, is_admin)
     VALUES ('proxy-ops@test.local', 'x', 'Proxy Ops', true) RETURNING id`,
  );
  userId = user.rows[0]!.id;
  key = await generateApiKey(db.pool, { userId, name: "proxy-test-key" });
  auth = { authorization: `Bearer ${key.plaintext}` };

  // The backend is never started: proxy routes must not need the flow engine.
  ctx = {
    pool: db.pool,
    backend: new GraphileWorkerBackend(db.pool, 1),
    executor: new LocalSkillExecutor(new Map()),
  };
  app = await buildApp(ctx);

  // Maker-checker fixture: preparer and approver roles in an SoD pair, one
  // agent each, plus an unconstrained bystander role and a suspended agent.
  await db.pool.query(
    `INSERT INTO roles (name) VALUES
     ('px-preparer-role'), ('px-approver-role'), ('px-bystander-role')`,
  );
  await db.pool.query(
    `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
     SELECT least(p.id, a.id), greatest(p.id, a.id), 'maker-checker: prepare vs approve'
       FROM roles p, roles a
      WHERE p.name = 'px-preparer-role' AND a.name = 'px-approver-role'`,
  );
  await db.pool.query(
    `INSERT INTO agents (name, role_id, status)
     SELECT v.name, r.id, v.status
       FROM (VALUES
         ('px-preparer', 'px-preparer-role', 'active'),
         ('px-approver', 'px-approver-role', 'active'),
         ('px-bystander', 'px-bystander-role', 'active'),
         ('px-benched', 'px-bystander-role', 'suspended')
       ) AS v(name, role_name, status)
       JOIN roles r ON r.name = v.role_name`,
  );
  for (const [name, riskTier] of [
    ["px-prepare", "low"],
    ["px-approve", "low"],
    ["px-observe", "low"],
    ["px-wire", "high"],
    ["px-sunset", "low"],
    ["px-revocable", "low"],
  ]) {
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ($1, 1, '{}', '{}', '{"type":"local"}', $2)`,
      [name, riskTier],
    );
  }
  for (const [roleName, skillName] of [
    ["px-preparer-role", "px-prepare"],
    ["px-approver-role", "px-approve"],
    ["px-bystander-role", "px-observe"],
    // High-risk skill IS granted — the gate requirement, not the grant, must block it.
    ["px-preparer-role", "px-wire"],
    ["px-preparer-role", "px-sunset"],
    ["px-preparer-role", "px-revocable"],
  ]) {
    await db.pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s
        WHERE r.name = $1 AND s.name = $2 AND s.version = 1`,
      [roleName, skillName],
    );
  }
  await db.pool.query("UPDATE skills SET status = 'deprecated' WHERE name = 'px-sunset'");
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.drop();
});

async function openSession(label = "test-session"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/proxy/sessions",
    headers: auth,
    payload: { label },
  });
  expect(res.statusCode).toBe(201);
  return res.json().session.id;
}

async function check(
  sessionId: string,
  agentName: string,
  skillRef: string,
  input?: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/proxy/sessions/${sessionId}/check`,
    headers: auth,
    payload: { agentName, skillRef, ...(input !== undefined ? { input } : {}) },
  });
}

async function sessionEvents(sessionId: string): Promise<string[]> {
  const { rows } = await db.pool.query<{ event_type: string }>(
    `SELECT event_type FROM audit_events
      WHERE entity_type = 'proxy_session' AND entity_id = $1 ORDER BY seq`,
    [sessionId],
  );
  return rows.map((r) => r.event_type);
}

async function sessionActions(sessionId: string) {
  const { rows } = await db.pool.query<{ skill_ref: string; decision: string }>(
    "SELECT skill_ref, decision FROM proxy_actions WHERE session_id = $1 ORDER BY created_at, id",
    [sessionId],
  );
  return rows;
}

describe("session lifecycle", () => {
  it("opens a session with the authenticated user recorded and audited", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/proxy/sessions",
      headers: auth,
      payload: { label: "langgraph-thread", externalRef: "thread-42" },
    });
    expect(res.statusCode).toBe(201);
    const session = res.json().session;
    expect(session).toMatchObject({
      label: "langgraph-thread",
      external_ref: "thread-42",
      status: "open",
      created_by_user_id: userId,
      closed_at: null,
    });
    const { rows } = await db.pool.query(
      `SELECT actor, payload FROM audit_events
        WHERE event_type = 'proxy.session.opened' AND entity_id = $1`,
      [session.id],
    );
    expect(rows[0].actor).toMatchObject({ type: "user", id: userId });
    expect(rows[0].payload).toMatchObject({
      sessionId: session.id,
      label: "langgraph-thread",
      externalRef: "thread-42",
    });
  });

  it("400s an empty label", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/proxy/sessions",
      headers: auth,
      payload: { label: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("record + close lifecycle: result audited, close audited, then 409s", async () => {
    const sessionId = await openSession("lifecycle");
    const checkRes = await check(sessionId, "px-preparer", "px-prepare@1", { batch: 7 });
    expect(checkRes.json().allowed).toBe(true);
    const checkId = checkRes.json().checkId;

    const record = await app.inject({
      method: "POST",
      url: `/api/proxy/sessions/${sessionId}/record`,
      headers: auth,
      payload: { checkId, output: { matched: 12 } },
    });
    expect(record.statusCode).toBe(200);
    expect(record.json()).toEqual({ ok: true });

    const close = await app.inject({
      method: "POST",
      url: `/api/proxy/sessions/${sessionId}/close`,
      headers: auth,
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().session.status).toBe("closed");
    expect(close.json().session.closed_at).not.toBeNull();

    expect(await sessionEvents(sessionId)).toEqual([
      "proxy.session.opened",
      "proxy.check.allowed",
      "proxy.result.recorded",
      "proxy.session.closed",
    ]);

    const again = await app.inject({
      method: "POST",
      url: `/api/proxy/sessions/${sessionId}/close`,
      headers: auth,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain("already closed");
  });

  it("denies checks on a closed session with 409 — and nothing is recorded", async () => {
    const sessionId = await openSession("closes-early");
    await app.inject({
      method: "POST",
      url: `/api/proxy/sessions/${sessionId}/close`,
      headers: auth,
    });
    const res = await check(sessionId, "px-preparer", "px-prepare@1");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("closed");
    expect(await sessionActions(sessionId)).toEqual([]);
  });
});

describe("authorization checks", () => {
  it("allows a granted skill: action row + audit event with the call input", async () => {
    const sessionId = await openSession("allowed-path");
    const res = await check(sessionId, "px-preparer", "px-prepare@1", { file: "stmt.csv" });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowed).toBe(true);
    expect(res.json().checkId).toMatch(/^[0-9a-f-]{36}$/);

    expect(await sessionActions(sessionId)).toEqual([
      { skill_ref: "px-prepare@1", decision: "allowed" },
    ]);
    const { rows } = await db.pool.query(
      `SELECT payload FROM audit_events
        WHERE event_type = 'proxy.check.allowed' AND entity_id = $1`,
      [sessionId],
    );
    expect(rows[0].payload).toMatchObject({
      sessionId,
      checkId: res.json().checkId,
      agentName: "px-preparer",
      skillRef: "px-prepare@1",
      input: { file: "stmt.csv" },
    });
  });

  it("denies an ungranted skill — deny by default, audited with via:proxy", async () => {
    const sessionId = await openSession("ungranted");
    // px-approve is granted to the approver role, never to the preparer's.
    const res = await check(sessionId, "px-preparer", "px-approve@1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ allowed: false, code: "skill_not_granted" });
    expect(res.json().reason).toContain("not granted");

    expect(await sessionActions(sessionId)).toEqual([
      { skill_ref: "px-approve@1", decision: "denied" },
    ]);
    const { rows } = await db.pool.query(
      `SELECT payload FROM audit_events
        WHERE event_type = 'enforcement.blocked' AND entity_id = $1`,
      [sessionId],
    );
    expect(rows[0].payload).toMatchObject({
      via: "proxy",
      sessionId,
      code: "skill_not_granted",
      agentName: "px-preparer",
      skillRef: "px-approve@1",
    });
  });

  it("denies after a grant is revoked — revocation is immediate", async () => {
    const sessionId = await openSession("revocation");
    const before = await check(sessionId, "px-preparer", "px-revocable@1");
    expect(before.json().allowed).toBe(true);

    await db.pool.query(
      `UPDATE role_skill_grants SET revoked_at = now()
        WHERE skill_id = (SELECT id FROM skills WHERE name = 'px-revocable')`,
    );
    const after = await check(sessionId, "px-preparer", "px-revocable@1");
    expect(after.json()).toMatchObject({ allowed: false, code: "skill_not_granted" });
  });

  it("denies high-risk skills outright, pointing at governed flows with gates", async () => {
    const sessionId = await openSession("high-risk");
    // The grant exists; the missing approval gate is what blocks it.
    const res = await check(sessionId, "px-preparer", "px-wire@1");
    expect(res.json()).toMatchObject({ allowed: false, code: "high_risk_requires_gate" });
    expect(res.json().reason).toMatch(/governed flow.*approval gate/);
    expect(await sessionActions(sessionId)).toEqual([
      { skill_ref: "px-wire@1", decision: "denied" },
    ]);
  });

  it("denies unknown agents, suspended agents, unknown and deprecated skills", async () => {
    const sessionId = await openSession("identity-checks");

    const ghost = await check(sessionId, "px-ghost", "px-prepare@1");
    expect(ghost.json()).toMatchObject({ allowed: false, code: "agent_not_found" });

    const benched = await check(sessionId, "px-benched", "px-observe@1");
    expect(benched.json()).toMatchObject({ allowed: false, code: "agent_not_active" });
    expect(benched.json().reason).toContain("suspended");

    const missing = await check(sessionId, "px-preparer", "no-such-skill@9");
    expect(missing.json()).toMatchObject({ allowed: false, code: "skill_not_found" });

    const sunset = await check(sessionId, "px-preparer", "px-sunset@1");
    expect(sunset.json()).toMatchObject({ allowed: false, code: "skill_deprecated" });

    // Unknown agents cannot be referenced by FK; every other denial left a row.
    expect(await sessionActions(sessionId)).toEqual([
      { skill_ref: "px-observe@1", decision: "denied" },
      { skill_ref: "no-such-skill@9", decision: "denied" },
      { skill_ref: "px-sunset@1", decision: "denied" },
    ]);
    // All four denials are audited, including the unknown agent.
    const { rows } = await db.pool.query(
      `SELECT count(*) AS n FROM audit_events
        WHERE event_type = 'enforcement.blocked' AND entity_id = $1`,
      [sessionId],
    );
    expect(Number(rows[0].n)).toBe(4);
  });
});

describe("segregation of duties across a session", () => {
  it("blocks a conflicting role after the other side already acted", async () => {
    const sessionId = await openSession("sod-cross");
    const prepare = await check(sessionId, "px-preparer", "px-prepare@1");
    expect(prepare.json().allowed).toBe(true);

    const approve = await check(sessionId, "px-approver", "px-approve@1");
    expect(approve.json()).toMatchObject({ allowed: false, code: "sod_violation" });
    expect(approve.json().reason).toContain("segregation of duties");
    expect(approve.json().reason).toContain("already acted in this session");

    const { rows } = await db.pool.query(
      `SELECT payload FROM audit_events
        WHERE event_type = 'enforcement.sod_violation' AND entity_id = $1`,
      [sessionId],
    );
    expect(rows[0].payload).toMatchObject({
      via: "proxy",
      sessionId,
      code: "sod_violation",
      agentName: "px-approver",
    });
  });

  it("the same role acting twice is NOT a violation — constraints bind role pairs", async () => {
    const sessionId = await openSession("sod-same-role");
    expect((await check(sessionId, "px-preparer", "px-prepare@1")).json().allowed).toBe(true);
    expect((await check(sessionId, "px-preparer", "px-prepare@1")).json().allowed).toBe(true);
  });

  it("unconstrained roles may share a session", async () => {
    const sessionId = await openSession("sod-bystander");
    expect((await check(sessionId, "px-preparer", "px-prepare@1")).json().allowed).toBe(true);
    expect((await check(sessionId, "px-bystander", "px-observe@1")).json().allowed).toBe(true);
  });

  it("denied attempts never enter the SoD actor set", async () => {
    const sessionId = await openSession("sod-denied-attempt");
    // The approver TRIES to act first but is denied (ungranted skill).
    const denied = await check(sessionId, "px-approver", "px-prepare@1");
    expect(denied.json()).toMatchObject({ allowed: false, code: "skill_not_granted" });
    // A blocked attempt did not act: the preparer must not be SoD-blocked by it.
    const prepare = await check(sessionId, "px-preparer", "px-prepare@1");
    expect(prepare.json().allowed).toBe(true);
  });

  it("sessions are isolated: acting in one never constrains another", async () => {
    const a = await openSession("sod-isolated-a");
    const b = await openSession("sod-isolated-b");
    expect((await check(a, "px-preparer", "px-prepare@1")).json().allowed).toBe(true);
    expect((await check(b, "px-approver", "px-approve@1")).json().allowed).toBe(true);
  });
});

describe("recording results", () => {
  it("404s unknown sessions and checks; 404s a checkId from another session", async () => {
    const sessionId = await openSession("record-404s");
    const ok = await check(sessionId, "px-preparer", "px-prepare@1");
    const checkId = ok.json().checkId;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/proxy/sessions/${ZERO}/record`,
          headers: auth,
          payload: { checkId },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/proxy/sessions/${sessionId}/record`,
          headers: auth,
          payload: { checkId: ZERO },
        })
      ).statusCode,
    ).toBe(404);

    const other = await openSession("record-404s-other");
    const cross = await app.inject({
      method: "POST",
      url: `/api/proxy/sessions/${other}/record`,
      headers: auth,
      payload: { checkId },
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error).toContain("not found in session");
  });

  it("409s recording a result against a denied check", async () => {
    const sessionId = await openSession("record-denied");
    await check(sessionId, "px-preparer", "px-approve@1"); // denied
    const { rows } = await db.pool.query<{ id: string }>(
      "SELECT id FROM proxy_actions WHERE session_id = $1 AND decision = 'denied'",
      [sessionId],
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/proxy/sessions/${sessionId}/record`,
      headers: auth,
      payload: { checkId: rows[0]!.id, output: { sneaky: true } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("denied");
  });

  it("records tool errors as evidence too", async () => {
    const sessionId = await openSession("record-error");
    const ok = await check(sessionId, "px-preparer", "px-prepare@1");
    const res = await app.inject({
      method: "POST",
      url: `/api/proxy/sessions/${sessionId}/record`,
      headers: auth,
      payload: { checkId: ok.json().checkId, error: { message: "downstream exploded" } },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await db.pool.query(
      `SELECT payload FROM audit_events
        WHERE event_type = 'proxy.result.recorded' AND entity_id = $1`,
      [sessionId],
    );
    expect(rows[0].payload).toMatchObject({
      skillRef: "px-prepare@1",
      error: { message: "downstream exploded" },
    });
  });
});

describe("session detail", () => {
  it("returns session + actions + that session's audit events, in order", async () => {
    const sessionId = await openSession("detail");
    await check(sessionId, "px-preparer", "px-prepare@1");
    await check(sessionId, "px-preparer", "px-approve@1"); // denied
    await app.inject({
      method: "POST",
      url: `/api/proxy/sessions/${sessionId}/close`,
      headers: auth,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/proxy/sessions/${sessionId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.session).toMatchObject({ id: sessionId, label: "detail", status: "closed" });
    expect(detail.actions).toHaveLength(2);
    expect(detail.actions[0]).toMatchObject({
      agent: "px-preparer",
      skill_ref: "px-prepare@1",
      decision: "allowed",
    });
    expect(detail.actions[1]).toMatchObject({ decision: "denied" });
    expect(detail.auditEvents.map((e: { event_type: string }) => e.event_type)).toEqual([
      "proxy.session.opened",
      "proxy.check.allowed",
      "enforcement.blocked",
      "proxy.session.closed",
    ]);
    // Only THIS session's events: every event payload carries this sessionId.
    for (const event of detail.auditEvents) {
      expect(event.payload.sessionId).toBe(sessionId);
    }
  });

  it("masks session label/external_ref and audit payloads on read when redaction is on", async () => {
    const open = await app.inject({
      method: "POST",
      url: "/api/proxy/sessions",
      headers: auth,
      payload: { label: "wire to victim@private.example", externalRef: "acct 4012888888881881" },
    });
    expect(open.statusCode).toBe(201);
    const sessionId = open.json().session.id as string;
    // A denied check stores the caller's skillRef verbatim in a proxy_actions row
    // — that free text can carry PII and must be masked on read too.
    await check(sessionId, "px-preparer", "transfer-4012888888881881@1");

    process.env.MAKERCHECKER_REDACTION = "example";
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/proxy/sessions/${sessionId}`,
        headers: auth,
      });
      const detail = res.json();
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain("victim@private.example");
      expect(serialized).not.toContain("4012888888881881");
      expect(detail.session.label).toBe("wire to [REDACTED:email]");
      expect(detail.session.external_ref).toBe("acct [REDACTED:number]");
      // the action row's caller-supplied skill_ref is masked as well
      expect(detail.actions).toHaveLength(1);
      expect(detail.actions[0].skill_ref).toBe("transfer-[REDACTED:number]@1");
    } finally {
      delete process.env.MAKERCHECKER_REDACTION;
    }
  });

  it("scopes check/record/close to the owner: a non-owner non-admin gets 404, the owner proceeds", async () => {
    const attacker = await db.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, is_admin)
       VALUES ('proxy-attacker@test.local', 'x', 'Attacker', false) RETURNING id`,
    );
    const attackerKey = await generateApiKey(db.pool, {
      userId: attacker.rows[0]!.id,
      name: "atk",
    });
    const atk = { authorization: `Bearer ${attackerKey.plaintext}` };

    // A session owned by someone else (here the admin via `auth`).
    const sessionId = await openSession("owned-elsewhere");

    // The non-owner non-admin cannot read, check, record, or close it — all 404
    // (same as a missing session, so existence does not leak).
    expect(
      (await app.inject({ method: "GET", url: `/api/proxy/sessions/${sessionId}`, headers: atk }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/proxy/sessions/${sessionId}/check`,
          headers: atk,
          payload: { agentName: "px-preparer", skillRef: "px-prepare@1" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/proxy/sessions/${sessionId}/record`,
          headers: atk,
          payload: { checkId: ZERO },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/proxy/sessions/${sessionId}/close`,
          headers: atk,
        })
      ).statusCode,
    ).toBe(404);
    // No action rows were injected into the victim's session.
    expect(await sessionActions(sessionId)).toEqual([]);

    // A non-admin acting on their OWN session reaches the checkpoint (not 404).
    const own = await app.inject({
      method: "POST",
      url: "/api/proxy/sessions",
      headers: atk,
      payload: { label: "attacker-own" },
    });
    const ownId = own.json().session.id as string;
    const ownCheck = await app.inject({
      method: "POST",
      url: `/api/proxy/sessions/${ownId}/check`,
      headers: atk,
      payload: { agentName: "px-preparer", skillRef: "px-prepare@1" },
    });
    expect(ownCheck.statusCode).toBe(200);
  });

  it("404s unknown sessions on GET, check, and close; 400s malformed ids", async () => {
    expect(
      (await app.inject({ method: "GET", url: `/api/proxy/sessions/${ZERO}`, headers: auth }))
        .statusCode,
    ).toBe(404);
    expect((await check(ZERO, "px-preparer", "px-prepare@1")).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/proxy/sessions/${ZERO}/close`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/proxy/sessions/not-a-uuid",
          headers: auth,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("requires an API key like every other /api route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/proxy/sessions",
      payload: { label: "no-key" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("OpenAPI + audit chain", () => {
  it("documents the proxy routes with operationIds and the proxy tag", async () => {
    const res = await app.inject({ method: "GET", url: "/api/openapi.json", headers: auth });
    const doc = res.json();
    expect(doc.paths["/api/proxy/sessions"].post.operationId).toBe("openProxySession");
    expect(doc.paths["/api/proxy/sessions/{id}/check"].post.tags).toContain("proxy");
    expect(doc.paths["/api/proxy/sessions/{id}/record"].post.operationId).toBe(
      "recordProxyResult",
    );
    expect(doc.paths["/api/proxy/sessions/{id}/close"].post.operationId).toBe(
      "closeProxySession",
    );
    expect(doc.paths["/api/proxy/sessions/{id}"].get.operationId).toBe("getProxySession");
  });

  it("the audit chain verifies after all proxy traffic", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit/verify", headers: auth });
    expect(res.json().ok).toBe(true);
    expect(res.json().count).toBeGreaterThan(20);
  });
});

describe("skillRef canonicalization — a non-canonical ref cannot skip the limit key", () => {
  // The skill is resolved by (name, version) but per-skill limits + invocation
  // counts are keyed by the ref string. A non-canonical ref ("px-prepare@01")
  // resolves to the same skill yet would miss the limit-map key. Both the HTTP
  // edge (pattern) and the service (round-trip guard) must reject it.
  it("rejects non-canonical skillRefs at the HTTP edge (400)", async () => {
    const sessionId = await openSession("canon-edge");
    for (const ref of ["px-prepare@01", "px-prepare@1@x", "PX-PREPARE@1", "px-prepare@0"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/proxy/sessions/${sessionId}/check`,
        headers: auth,
        payload: { agentName: "px-preparer", skillRef: ref },
      });
      expect(res.statusCode, ref).toBe(400);
    }
  });

  it("the service denies a non-canonical ref that resolves to a real granted skill", async () => {
    const sessionId = await openSession("canon-svc");
    const actor = { type: "user" as const, id: userId };

    // Canonical spelling of a real, granted skill is allowed...
    const ok = await checkAndAuthorize(db.pool, {
      sessionId,
      agentName: "px-preparer",
      skillRef: "px-prepare@1",
      input: {},
      actor,
    });
    expect(ok.allowed).toBe(true);

    // ...but the non-canonical spelling of the SAME skill is denied by the guard,
    // so it can never reach the (ref-keyed) limit check and skip a ceiling.
    const bypass = await checkAndAuthorize(db.pool, {
      sessionId,
      agentName: "px-preparer",
      skillRef: "px-prepare@01",
      input: {},
      actor,
    });
    expect(bypass.allowed).toBe(false);
    if (!bypass.allowed) expect(bypass.code).toBe("skill_not_found");
  });
});

describe("argument-level grant policy through the proxy route layer", () => {
  // Seeds two roles whose limits carry the new per-skill argument predicates
  // (allowlist + pathScope), each with its own agent / granted low-risk skill,
  // then drives the SAME /check route the rest of this suite uses. The point of
  // these tests is the ROUTE layer: a check POSTed over HTTP with an off-list
  // destination / out-of-prefix path must surface the new ProxyDenialCode values
  // (limit_allowlist / limit_path and their _unreadable twins) in the JSON body
  // at status 200 — a denial is a decision, not an error — and audit each as
  // enforcement.limit_violation {via:'proxy', code}. Limits live in roles.limits
  // keyed by the canonical skillRef, the same place getRoleLimits reads.
  beforeAll(async () => {
    await db.pool.query(
      `INSERT INTO roles (name, limits) VALUES
       ('px-allowlist-role', $1::jsonb),
       ('px-pathscope-role', $2::jsonb)`,
      [
        JSON.stringify({
          skills: { "px-send@1": { allowlist: { field: "destination", values: ["acct-ok"] } } },
        }),
        JSON.stringify({
          skills: { "px-write@1": { pathScope: { field: "path", prefix: "/srv/project" } } },
        }),
      ],
    );
    await db.pool.query(
      `INSERT INTO agents (name, role_id, status)
       SELECT v.name, r.id, 'active'
         FROM (VALUES
           ('px-sender', 'px-allowlist-role'),
           ('px-writer', 'px-pathscope-role')
         ) AS v(name, role_name)
         JOIN roles r ON r.name = v.role_name`,
    );
    // Low-risk skills: the high-risk gate must NOT pre-empt the argument check.
    for (const skill of ["px-send", "px-write"]) {
      await db.pool.query(
        `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
         VALUES ($1, 1, '{}', '{}', '{"type":"local"}', 'low')`,
        [skill],
      );
    }
    for (const [roleName, skillName] of [
      ["px-allowlist-role", "px-send"],
      ["px-pathscope-role", "px-write"],
    ]) {
      await db.pool.query(
        `INSERT INTO role_skill_grants (role_id, skill_id)
         SELECT r.id, s.id FROM roles r, skills s
          WHERE r.name = $1 AND s.name = $2 AND s.version = 1`,
        [roleName, skillName],
      );
    }
  }, 60_000);

  async function limitEvent(sessionId: string) {
    const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events
        WHERE event_type = 'enforcement.limit_violation' AND entity_id = $1`,
      [sessionId],
    );
    return rows;
  }

  it("denies an off-list destination over the route: 200 {allowed:false, code:'limit_allowlist'}", async () => {
    const sessionId = await openSession("allowlist-offlist");
    const res = await check(sessionId, "px-sender", "px-send@1", { destination: "acct-evil" });
    // A denial is a 200 decision so SDK wrappers branch without exception plumbing.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ allowed: false, code: "limit_allowlist" });
    expect(res.json().reason).toContain("allowlist");

    // The denial left a denied action row and a proxy-tagged limit-violation event.
    expect(await sessionActions(sessionId)).toEqual([
      { skill_ref: "px-send@1", decision: "denied" },
    ]);
    const events = await limitEvent(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      via: "proxy",
      sessionId,
      code: "limit_allowlist",
      agentName: "px-sender",
      skillRef: "px-send@1",
    });
  });

  it("denies a missing/non-string destination as limit_allowlist_unreadable (fail closed)", async () => {
    const sessionId = await openSession("allowlist-unreadable");
    // No 'destination' field at all: the allowlist cannot be read, so it denies.
    const missing = await check(sessionId, "px-sender", "px-send@1", { other: "x" });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({ allowed: false, code: "limit_allowlist_unreadable" });

    // Present but not a string is equally unreadable.
    const nonString = await check(sessionId, "px-sender", "px-send@1", { destination: 7 });
    expect(nonString.json()).toMatchObject({
      allowed: false,
      code: "limit_allowlist_unreadable",
    });
  });

  it("allows an on-list destination: the allowlist gates the value, not the skill", async () => {
    const sessionId = await openSession("allowlist-onlist");
    const res = await check(sessionId, "px-sender", "px-send@1", { destination: "acct-ok" });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowed).toBe(true);
    expect(await sessionActions(sessionId)).toEqual([
      { skill_ref: "px-send@1", decision: "allowed" },
    ]);
  });

  it("denies an out-of-prefix path over the route: 200 {allowed:false, code:'limit_path'}", async () => {
    const sessionId = await openSession("pathscope-outside");
    const res = await check(sessionId, "px-writer", "px-write@1", { path: "/etc/passwd" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ allowed: false, code: "limit_path" });
    expect(res.json().reason).toContain("/srv/project");

    expect(await sessionActions(sessionId)).toEqual([
      { skill_ref: "px-write@1", decision: "denied" },
    ]);
    const events = await limitEvent(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      via: "proxy",
      sessionId,
      code: "limit_path",
      agentName: "px-writer",
      skillRef: "px-write@1",
    });
  });

  it("denies traversal that escapes the prefix as limit_path (no startsWith bypass)", async () => {
    const sessionId = await openSession("pathscope-traversal");
    // Lexically under the prefix but normalizes out of it via '..' — must deny.
    const res = await check(sessionId, "px-writer", "px-write@1", {
      path: "/srv/project/../../etc/shadow",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ allowed: false, code: "limit_path" });
  });

  it("denies a missing/empty/non-string path as limit_path_unreadable (fail closed)", async () => {
    const sessionId = await openSession("pathscope-unreadable");
    const missing = await check(sessionId, "px-writer", "px-write@1", { other: "x" });
    expect(missing.json()).toMatchObject({ allowed: false, code: "limit_path_unreadable" });

    const empty = await check(sessionId, "px-writer", "px-write@1", { path: "" });
    expect(empty.json()).toMatchObject({ allowed: false, code: "limit_path_unreadable" });

    const nonString = await check(sessionId, "px-writer", "px-write@1", { path: 42 });
    expect(nonString.json()).toMatchObject({ allowed: false, code: "limit_path_unreadable" });
  });

  it("allows a path under the prefix: the scope gates the value, not the skill", async () => {
    const sessionId = await openSession("pathscope-inside");
    const res = await check(sessionId, "px-writer", "px-write@1", {
      path: "/srv/project/reports/q3.csv",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowed).toBe(true);
    expect(await sessionActions(sessionId)).toEqual([
      { skill_ref: "px-write@1", decision: "allowed" },
    ]);
  });
});
