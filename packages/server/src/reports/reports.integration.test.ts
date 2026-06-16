import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "@makerchecker/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { buildApp } from "../app.js";
import { ensureInstanceKeys } from "../audit/keys.js";
import { verifyChain } from "../audit/verify.js";
import { GraphileWorkerBackend } from "../engine/graphile-backend.js";
import { LocalSkillExecutor, type LocalSkillFn } from "../engine/executor.js";
import { publishFlowVersion } from "../engine/flows.js";
import {
  createHandlers,
  decideApproval,
  startRun,
  type EngineContext,
} from "../engine/orchestrator.js";
import { getAccessReview, renderAccessReviewHtml } from "./access-review.js";
import { esc, hashPrefix, summarizeJson } from "./html.js";
import { renderRunReportHtml } from "./run-report.js";

const USER = { type: "user" as const, id: "rep-user", name: "Report Tester" };
const DECISION_REASON = "Variance traced to duplicate feed; verified against custodian statement.";

let db: TestDb;
let ctx: EngineContext;
let app: Awaited<ReturnType<typeof buildApp>>;
let dataDir: string;
let runId: string;
let publicKeyPem: string;
let reviewerEmail: string;
let reviewerId: string;

const registry = new Map<string, LocalSkillFn>();

async function waitForRunStatus(id: string, statuses: string[], timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.pool.query<{ status: string }>(
      "SELECT status FROM flow_runs WHERE id = $1",
      [id],
    );
    const status = rows[0]!.status;
    if (statuses.includes(status)) return status;
    if (Date.now() > deadline) throw new Error(`run ${id} stuck at "${status}"`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  process.env.MAKERCHECKER_AUTH_DISABLED = "1";
  db = await createTestDb();
  dataDir = mkdtempSync(join(tmpdir(), "mc-report-keys-"));
  ({ publicKeyPem } = await ensureInstanceKeys(db.pool, dataDir));

  // Governed world: one role/agent pair that runs the flow, a second role for
  // SoD, a human reviewer who grants and revokes.
  await db.pool.query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ('reviewer@example.test', 'x', 'Reviewer')`,
  );
  const reviewer = await db.pool.query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE email = 'reviewer@example.test'",
  );
  reviewerId = reviewer.rows[0]!.id;
  reviewerEmail = reviewer.rows[0]!.email;

  await db.pool.query(
    `INSERT INTO roles (name, description) VALUES
       ('report-runner-role', 'Runs the reported flow'),
       ('report-checker-role', 'Conflicting checker role')`,
  );
  await db.pool.query(
    `INSERT INTO agents (name, role_id)
     SELECT 'report-agent', id FROM roles WHERE name = 'report-runner-role'`,
  );
  await db.pool.query(
    `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
     VALUES ('report-skill', 1, '{}', '{}', '{"type":"local"}', 'low'),
            ('revoked-skill', 1, '{}', '{}', '{"type":"local"}', 'low')`,
  );
  // One active grant, one revoked grant — the review must show both states.
  await db.pool.query(
    `INSERT INTO role_skill_grants (role_id, skill_id, granted_by_user_id)
     SELECT r.id, s.id, $1 FROM roles r, skills s
      WHERE r.name = 'report-runner-role' AND s.name IN ('report-skill', 'revoked-skill')`,
    [reviewerId],
  );
  await db.pool.query(
    `UPDATE role_skill_grants g SET revoked_at = now(), revoked_by_user_id = $1
      FROM skills s WHERE s.id = g.skill_id AND s.name = 'revoked-skill'`,
    [reviewerId],
  );
  await db.pool.query(
    `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
     SELECT least(a.id, b.id), greatest(a.id, b.id), 'runner may not also check'
       FROM roles a, roles b
      WHERE a.name = 'report-runner-role' AND b.name = 'report-checker-role'`,
  );
  registry.set("report-skill@1", async (input) => ({ ...input, prepared: true }));

  const backend = new GraphileWorkerBackend(db.pool, 5);
  ctx = { pool: db.pool, backend, executor: new LocalSkillExecutor(registry) };
  await backend.start(createHandlers(ctx));
  app = await buildApp(ctx);

  // The seeded run the evidence pack renders: prepare -> gate -> report.
  const { flowVersionId } = await publishFlowVersion(db.pool, {
    actor: USER,
    definition: {
      name: "evidence-flow",
      steps: [
        { key: "prepare", agent: "report-agent", skills: ["report-skill@1"] },
        { key: "review_gate", type: "approval_gate", title: "Review before reporting" },
        { key: "deliver", agent: "report-agent", skills: ["report-skill@1"] },
      ],
    },
  });
  runId = await startRun(ctx, {
    flowVersionId,
    triggeredBy: USER,
    runInput: { contact: "pii.subject@example.test", account: "9876543210123456" },
  });
  await waitForRunStatus(runId, ["waiting_approval"]);
  const approval = await db.pool.query<{ id: string }>(
    "SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'",
    [runId],
  );
  await decideApproval(ctx, {
    approvalId: approval.rows[0]!.id,
    decision: "approved",
    decidedBy: USER,
    reason: DECISION_REASON,
  });
  await waitForRunStatus(runId, ["completed"]);
}, 60_000);

afterAll(async () => {
  delete process.env.MAKERCHECKER_AUTH_DISABLED;
  delete process.env.MAKERCHECKER_REDACTION;
  await app.close();
  await ctx.backend.stop();
  await db.drop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("html helpers", () => {
  it("escapes HTML metacharacters", () => {
    expect(esc(`<img src="x" onerror=alert(1)>&`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=alert(1)&gt;&amp;",
    );
    expect(esc(null)).toBe("");
  });

  it("hashPrefix truncates to 16 hex chars and dashes out missing hashes", () => {
    expect(hashPrefix("a".repeat(64))).toBe(`${"a".repeat(16)}…`);
    expect(hashPrefix(null)).toBe("—");
  });

  it("summarizeJson truncates huge payloads", () => {
    const long = summarizeJson({ blob: "x".repeat(2000) });
    expect(long).toContain("… (");
    expect(long.length).toBeLessThan(700);
    expect(summarizeJson(undefined)).toBe("—");
  });
});

describe("renderRunReportHtml — the run evidence pack", () => {
  let html: string;

  it("renders a self-contained document for the seeded run", async () => {
    html = await renderRunReportHtml(db.pool, runId);
    expect(html).toContain("<!doctype html");
    expect(html).toContain("Run evidence pack");
    expect(html).toContain("evidence-flow");
    expect(html).toContain(runId);
    // Self-contained: inline CSS only, no external assets.
    expect(html).not.toMatch(/<script|<link|src="http|url\(http/);
  });

  it("shows the step timeline with I/O summaries", () => {
    expect(html).toContain("prepare");
    expect(html).toContain("deliver");
    expect(html).toContain("report-agent");
    expect(html).toContain("&quot;prepared&quot;:true");
  });

  it("records every approval decision with the reason VERBATIM", () => {
    expect(html).toContain("review_gate");
    expect(html).toContain(DECISION_REASON);
    expect(html).toContain("Report Tester");
  });

  it("lists the audit events with hash prefixes", async () => {
    const { rows } = await db.pool.query<{ event_type: string; hash: string }>(
      "SELECT event_type, hash FROM audit_events WHERE run_id = $1 ORDER BY seq",
      [runId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(html).toContain(row.event_type);
      expect(html).toContain(row.hash.slice(0, 16));
    }
  });

  it("carries the chain verification PASS, head hash, and key fingerprint", async () => {
    const verification = await verifyChain(db.pool);
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(html).toContain("PASSED");
    expect(html).toContain(verification.headHash!);
    expect(html).toContain(sha256Hex(publicKeyPem).slice(0, 16));
  });

  it("applies the configured redaction hook exactly like the read API", async () => {
    expect(html).toContain("pii.subject@example.test"); // hookless render is raw
    process.env.MAKERCHECKER_REDACTION = "example";
    try {
      const masked = await renderRunReportHtml(db.pool, runId);
      expect(masked).not.toContain("pii.subject@example.test");
      expect(masked).not.toContain("9876543210123456");
      expect(masked).toContain("[REDACTED:email]");
      expect(masked).toContain("[REDACTED:number]");
    } finally {
      delete process.env.MAKERCHECKER_REDACTION;
    }
  });

  it("redacts a secret embedded in a FAILED run's failure_reason", async () => {
    // A skill that throws with a secret → failure_reason carries it into the
    // signed evidence pack; the read-path hook must mask it like step I/O.
    // Uses a SEPARATE role/agent so the access-review assertions stay exact.
    await db.pool.query("INSERT INTO roles (name) VALUES ('report-boom-role')");
    await db.pool.query(
      `INSERT INTO agents (name, role_id)
       SELECT 'report-boom-agent', id FROM roles WHERE name = 'report-boom-role'`,
    );
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('report-boom', 1, '{}', '{}', '{"type":"local"}', 'low')`,
    );
    await db.pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id, granted_by_user_id)
       SELECT r.id, s.id, $1 FROM roles r, skills s
        WHERE r.name = 'report-boom-role' AND s.name = 'report-boom' AND s.version = 1`,
      [reviewerId],
    );
    registry.set("report-boom@1", async () => {
      throw new Error("wire to leak@private.test (acct 4012888888881881) failed");
    });
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      actor: USER,
      definition: {
        name: "evidence-fail-flow",
        steps: [{ key: "boom", agent: "report-boom-agent", skills: ["report-boom@1"] }],
      },
    });
    const failedRunId = await startRun(ctx, { flowVersionId, triggeredBy: USER, runInput: {} });
    expect(await waitForRunStatus(failedRunId, ["failed"])).toBe("failed");

    // At rest the failure_reason column holds the raw secret (storage is raw).
    const raw = await db.pool.query<{ failure_reason: string }>(
      "SELECT failure_reason FROM flow_runs WHERE id = $1",
      [failedRunId],
    );
    expect(raw.rows[0]!.failure_reason).toContain("4012888888881881");

    // With redaction on, the rendered evidence pack masks it.
    process.env.MAKERCHECKER_REDACTION = "example";
    try {
      const masked = await renderRunReportHtml(db.pool, failedRunId);
      expect(masked).not.toContain("leak@private.test");
      expect(masked).not.toContain("4012888888881881");
      expect(masked).toContain("[REDACTED:number]");
    } finally {
      delete process.env.MAKERCHECKER_REDACTION;
    }
  });

  it("refuses to render an unknown run", async () => {
    await expect(
      renderRunReportHtml(db.pool, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/not found/);
  });

  it("ADVERSARIAL: a tampered audit row turns the report into a failure notice", async () => {
    const original = await db.pool.query<{ seq: string; payload: unknown }>(
      "SELECT seq, payload FROM audit_events WHERE run_id = $1 ORDER BY seq LIMIT 1",
      [runId],
    );
    const { seq, payload } = original.rows[0]!;
    await db.pool.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete");
    try {
      await db.pool.query(`UPDATE audit_events SET payload = '{"forged":true}' WHERE seq = $1`, [
        seq,
      ]);
      const tampered = await renderRunReportHtml(db.pool, runId);
      expect(tampered).toContain("FAILED");
      expect(tampered).toContain("must not be relied on");
      expect(tampered).not.toContain("Chain verification: PASSED");
    } finally {
      await db.pool.query("UPDATE audit_events SET payload = $2 WHERE seq = $1", [
        seq,
        JSON.stringify(payload),
      ]);
      await db.pool.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete");
    }
    // Restoration leaves the chain whole again — the suite stays trustworthy.
    expect((await verifyChain(db.pool)).ok).toBe(true);
  });
});

describe("access review", () => {
  it("getAccessReview reports agents, active grants, history, revocations, SoD", async () => {
    const review = await getAccessReview(db.pool);
    const role = review.roles.find((r) => r.name === "report-runner-role");
    expect(role).toBeDefined();
    expect(role!.agents).toContainEqual({ name: "report-agent", status: "active" });

    expect(role!.activeGrants).toHaveLength(1);
    expect(role!.activeGrants[0]).toMatchObject({
      skill: "report-skill",
      version: 1,
      grantedBy: reviewerEmail,
    });

    const revoked = role!.grantHistory.find((g) => g.skill === "revoked-skill");
    expect(revoked).toBeDefined();
    expect(revoked!.revokedAt).not.toBeNull();
    expect(revoked!.revokedBy).toBe(reviewerEmail);

    expect(role!.sodConstraints).toHaveLength(1);
    expect(role!.sodConstraints[0]).toMatchObject({
      withRole: "report-checker-role",
      description: "runner may not also check",
      revokedAt: null,
    });

    // Deny by default is visible: the checker role has no grants at all.
    const checker = review.roles.find((r) => r.name === "report-checker-role");
    expect(checker!.activeGrants).toHaveLength(0);
    expect(checker!.grantHistory).toHaveLength(0);
  });

  it("renderAccessReviewHtml shows role, grant, and revocation lines", async () => {
    const html = await renderAccessReviewHtml(db.pool);
    expect(html).toContain("Access review");
    expect(html).toContain("Role: report-runner-role");
    expect(html).toContain("report-agent");
    expect(html).toContain("report-skill@1");
    expect(html).toContain("revoked-skill@1");
    expect(html).toMatch(/REVOKED \d{4}-\d{2}-\d{2}T/);
    expect(html).toContain(reviewerEmail);
    expect(html).toContain("runner may not also check");
    expect(html).toContain("no active grants (deny by default)");
    expect(html).not.toMatch(/<script|<link/);
  });

  it("GET /api/reports/access-review returns the same data as JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/reports/access-review" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      generatedAt: string;
      roles: Array<{
        name: string;
        agents: unknown[];
        activeGrants: unknown[];
        grantHistory: Array<{ skill: string; revokedAt: string | null; revokedBy: string | null }>;
        sodConstraints: unknown[];
      }>;
    };
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const role = body.roles.find((r) => r.name === "report-runner-role");
    expect(role).toBeDefined();
    expect(role!.agents).toEqual([{ name: "report-agent", status: "active" }]);
    expect(role!.activeGrants).toHaveLength(1);
    const revoked = role!.grantHistory.find((g) => g.skill === "revoked-skill");
    expect(revoked!.revokedAt).not.toBeNull();
    expect(revoked!.revokedBy).toBe(reviewerEmail);
    expect(role!.sodConstraints).toHaveLength(1);
  });
});
