import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../test/test-db.js";
import { buildApp } from "./app.js";
import { GraphileWorkerBackend } from "./engine/graphile-backend.js";
import { LocalSkillExecutor, type LocalSkillFn } from "./engine/executor.js";
import { publishFlowVersion } from "./engine/flows.js";
import { createHandlers, startRun, type EngineContext } from "./engine/orchestrator.js";
import { overdueThresholdMinutes, sweepOverdueApprovals } from "./engine/watchdog.js";
import { webhookFailureCount } from "./webhooks/dispatcher.js";

/**
 * M14/M15 ops surface: read-path redaction on run detail, /metrics
 * exposition, overdue-approval signals on the approvals API and the
 * watchdog's single-shot overdue sweep.
 */

const USER = { type: "user" as const, id: "ops-user", name: "Ops Tester" };
const PII_EMAIL = "victim.account@corp.example";
const PII_ACCOUNT = "12345678901234";

let db: TestDb;
let ctx: EngineContext;
let app: Awaited<ReturnType<typeof buildApp>>;
let flowVersionId: string;
let receiver: Server;
const received: Array<{ event: string; runId: string; data: Record<string, unknown> }> = [];

const registry = new Map<string, LocalSkillFn>();
const PREV_ALLOW_PRIVATE = process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;

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

async function startGatedRun(): Promise<{ runId: string; approvalId: string }> {
  const runId = await startRun(ctx, {
    flowVersionId,
    triggeredBy: USER,
    runInput: { contactEmail: PII_EMAIL, account: PII_ACCOUNT },
  });
  await waitForRunStatus(runId, ["waiting_approval"]);
  const { rows } = await db.pool.query<{ id: string }>(
    "SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'",
    [runId],
  );
  return { runId, approvalId: rows[0]!.id };
}

async function backdateApproval(approvalId: string, interval = "2 hours"): Promise<void> {
  await db.pool.query(
    `UPDATE approvals SET requested_at = now() - $2::interval WHERE id = $1`,
    [approvalId, interval],
  );
}

async function overdueEventCount(approvalId: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_events
      WHERE event_type = 'approval.overdue' AND entity_id = $1`,
    [approvalId],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  process.env.MAKERCHECKER_AUTH_DISABLED = "1";
  process.env.MAKERCHECKER_METRICS = "1";
  // The overdue-sweep webhook lands on a 127.0.0.1 receiver; opt the dispatcher's
  // SSRF egress guard in for the test process only (production never sets this).
  process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
  db = await createTestDb();

  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push(JSON.parse(body) as (typeof received)[number]);
      res.writeHead(204).end();
    });
  });
  const receiverUrl = await new Promise<string>((resolve) => {
    receiver.listen(0, "127.0.0.1", () => {
      const { port } = receiver.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  await db.pool.query(
    "INSERT INTO webhook_endpoints (url, secret, enabled) VALUES ($1, 'ops-secret', true)",
    [receiverUrl],
  );

  await db.pool.query("INSERT INTO roles (name) VALUES ('ops-role')");
  await db.pool.query(
    "INSERT INTO agents (name, role_id) SELECT 'ops-agent', id FROM roles WHERE name = 'ops-role'",
  );
  await db.pool.query(
    `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
     VALUES ('ops-skill', 1, '{}', '{}', '{"type":"local"}', 'low')`,
  );
  await db.pool.query(
    `INSERT INTO role_skill_grants (role_id, skill_id)
     SELECT r.id, s.id FROM roles r, skills s WHERE r.name = 'ops-role'`,
  );
  registry.set("ops-skill@1", async (input) => ({ ...input, handled: true }));

  const backend = new GraphileWorkerBackend(db.pool, 5);
  ctx = { pool: db.pool, backend, executor: new LocalSkillExecutor(registry) };
  await backend.start(createHandlers(ctx));
  app = await buildApp(ctx);

  ({ flowVersionId } = await publishFlowVersion(db.pool, {
    actor: USER,
    definition: {
      name: "ops-flow",
      steps: [
        { key: "leak", agent: "ops-agent", skills: ["ops-skill@1"] },
        { key: "hold", type: "approval_gate", title: "Hold for review" },
      ],
    },
  }));
}, 60_000);

afterAll(async () => {
  delete process.env.MAKERCHECKER_AUTH_DISABLED;
  delete process.env.MAKERCHECKER_METRICS;
  delete process.env.MAKERCHECKER_REDACTION;
  delete process.env.MAKERCHECKER_APPROVAL_OVERDUE_MINUTES;
  if (PREV_ALLOW_PRIVATE === undefined) delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
  else process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = PREV_ALLOW_PRIVATE;
  await app.close();
  await ctx.backend.stop();
  await new Promise((resolve) => receiver.close(resolve));
  await db.drop();
});

describe("overdueThresholdMinutes — fail-closed parsing", () => {
  it.each([
    [undefined, 60],
    ["", 60],
    ["15", 15],
    ["banana", 60],
    ["-5", 60],
    ["0", 60],
  ])("MAKERCHECKER_APPROVAL_OVERDUE_MINUTES=%j -> %d", (raw, expected) => {
    if (raw === undefined) delete process.env.MAKERCHECKER_APPROVAL_OVERDUE_MINUTES;
    else process.env.MAKERCHECKER_APPROVAL_OVERDUE_MINUTES = raw;
    try {
      expect(overdueThresholdMinutes()).toBe(expected);
    } finally {
      delete process.env.MAKERCHECKER_APPROVAL_OVERDUE_MINUTES;
    }
  });
});

describe("read-path redaction on GET /api/runs/:id", () => {
  let runId: string;

  it("without a hook the response is raw (default: none)", async () => {
    ({ runId } = await startGatedRun());
    delete process.env.MAKERCHECKER_REDACTION;
    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(PII_EMAIL);
    expect(res.body).toContain(PII_ACCOUNT);
  });

  it("with MAKERCHECKER_REDACTION=example the planted email and account are masked everywhere", async () => {
    process.env.MAKERCHECKER_REDACTION = "example";
    try {
      const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(PII_EMAIL);
      expect(res.body).not.toContain(PII_ACCOUNT);
      expect(res.body).toContain("[REDACTED:email]");
      expect(res.body).toContain("[REDACTED:number]");

      const detail = res.json() as {
        run: { input: Record<string, unknown> };
        steps: Array<{ step_key: string; input: Record<string, unknown>; output: Record<string, unknown> }>;
        auditEvents: Array<{ event_type: string; payload: Record<string, unknown> }>;
      };
      expect(detail.run.input.contactEmail).toBe("[REDACTED:email]");
      const leak = detail.steps.find((s) => s.step_key === "leak");
      expect(leak!.input.contactEmail).toBe("[REDACTED:email]");
      expect(leak!.output.account).toBe("[REDACTED:number]");
      const completed = detail.auditEvents.find((e) => e.event_type === "run.step.completed");
      expect(JSON.stringify(completed!.payload)).toContain("[REDACTED:email]");
    } finally {
      delete process.env.MAKERCHECKER_REDACTION;
    }
  });

  it("at-rest rows stay RAW — the hook governs exposure, not storage", async () => {
    const { rows } = await db.pool.query<{ output: Record<string, unknown> }>(
      "SELECT output FROM step_runs WHERE run_id = $1 AND step_key = 'leak'",
      [runId],
    );
    expect(rows[0]!.output.contactEmail).toBe(PII_EMAIL);
  });

  it("masks a FAILED run's failure_reason in /api/runs/:id AND the run list", async () => {
    // failure_reason embeds the raw skill error, which can carry PII. Separate
    // governed world so the /metrics counts (derived dynamically) are unaffected.
    await db.pool.query("INSERT INTO roles (name) VALUES ('ops-boom-role')");
    await db.pool.query(
      "INSERT INTO agents (name, role_id) SELECT 'ops-boom-agent', id FROM roles WHERE name = 'ops-boom-role'",
    );
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('ops-boom', 1, '{}', '{}', '{"type":"local"}', 'low')`,
    );
    await db.pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s WHERE r.name = 'ops-boom-role' AND s.name = 'ops-boom'`,
    );
    registry.set("ops-boom@1", async () => {
      throw new Error(`wire to ${PII_EMAIL} (acct ${PII_ACCOUNT}) failed`);
    });
    const { flowVersionId: boomFv } = await publishFlowVersion(db.pool, {
      actor: USER,
      definition: {
        name: "ops-boom-flow",
        steps: [{ key: "boom", agent: "ops-boom-agent", skills: ["ops-boom@1"] }],
      },
    });
    const boomRun = await startRun(ctx, { flowVersionId: boomFv, triggeredBy: USER, runInput: {} });
    expect(await waitForRunStatus(boomRun, ["failed"])).toBe("failed");

    process.env.MAKERCHECKER_REDACTION = "example";
    try {
      const res = await app.inject({ method: "GET", url: `/api/runs/${boomRun}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(PII_EMAIL);
      expect(res.body).not.toContain(PII_ACCOUNT);
      expect(String(res.json().run.failure_reason)).toContain("[REDACTED:number]");

      const list = await app.inject({ method: "GET", url: "/api/runs" });
      expect(list.body).not.toContain(PII_EMAIL);
      expect(list.body).not.toContain(PII_ACCOUNT);
    } finally {
      delete process.env.MAKERCHECKER_REDACTION;
    }
  });
});

describe("GET /api/approvals — overdue signal", () => {
  it("a fresh approval is not overdue and reports its age", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json() as {
      approvals: Array<{ id: string; overdue: boolean; age_seconds: number }>;
    };
    expect(inbox.approvals.length).toBeGreaterThan(0);
    for (const ap of inbox.approvals) {
      expect(ap.overdue).toBe(false);
      expect(ap.age_seconds).toBeGreaterThanOrEqual(0);
      expect(ap.age_seconds).toBeLessThan(120);
    }
  });

  it("an approval older than the threshold reports overdue=true with its age", async () => {
    const { approvalId } = await startGatedRun();
    await backdateApproval(approvalId);
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json() as {
      approvals: Array<{ id: string; overdue: boolean; age_seconds: number }>;
    };
    const overdue = inbox.approvals.find((a) => a.id === approvalId);
    expect(overdue!.overdue).toBe(true);
    expect(overdue!.age_seconds).toBeGreaterThanOrEqual(7100);
  });
});

describe("watchdog overdue sweep — ONE notification per approval, ever", () => {
  it("fires approval.overdue audit + webhook for a backdated approval", async () => {
    const { runId, approvalId } = await startGatedRun();
    await backdateApproval(approvalId);

    const notified = await sweepOverdueApprovals(ctx);
    expect(notified).toBeGreaterThanOrEqual(1);

    expect(await overdueEventCount(approvalId)).toBe(1);
    const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM audit_events WHERE event_type = 'approval.overdue' AND entity_id = $1",
      [approvalId],
    );
    expect(rows[0]!.payload).toMatchObject({ stepKey: "hold", thresholdMinutes: 60 });
    expect(Number(rows[0]!.payload.ageSeconds)).toBeGreaterThanOrEqual(7100);

    const deadline = Date.now() + 10_000;
    for (;;) {
      const hit = received.find((d) => d.event === "approval.overdue" && d.runId === runId);
      if (hit) {
        expect(hit.data).toMatchObject({ approvalId, stepKey: "hold" });
        break;
      }
      if (Date.now() > deadline) throw new Error("approval.overdue webhook never arrived");
      await new Promise((r) => setTimeout(r, 50));
    }

    // ADVERSARIAL: a second sweep must not re-notify.
    expect(await sweepOverdueApprovals(ctx)).toBe(0);
    expect(await overdueEventCount(approvalId)).toBe(1);
  });

  it("ADVERSARIAL: concurrent sweepers race for the claim — exactly one wins", async () => {
    const { approvalId } = await startGatedRun();
    await backdateApproval(approvalId);

    const [a, b] = await Promise.all([sweepOverdueApprovals(ctx), sweepOverdueApprovals(ctx)]);
    expect(a + b).toBe(1);
    expect(await overdueEventCount(approvalId)).toBe(1);
  });

  it("approvals inside the threshold are left alone", async () => {
    const { approvalId } = await startGatedRun();
    expect(await sweepOverdueApprovals(ctx)).toBe(0);
    const { rows } = await db.pool.query<{ notified_overdue_at: Date | null }>(
      "SELECT notified_overdue_at FROM approvals WHERE id = $1",
      [approvalId],
    );
    expect(rows[0]!.notified_overdue_at).toBeNull();
    expect(await overdueEventCount(approvalId)).toBe(0);
  });

  it("honours an explicit overdueMinutes option", async () => {
    const { approvalId } = await startGatedRun();
    await backdateApproval(approvalId, "10 minutes");
    expect(await sweepOverdueApprovals(ctx, { overdueMinutes: 5 })).toBeGreaterThanOrEqual(1);
    expect(await overdueEventCount(approvalId)).toBe(1);
  });
});

describe("GET /metrics — Prometheus exposition", () => {
  it("serves hand-rolled text format with live values", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");

    const runs = await db.pool.query<{ status: string; n: string }>(
      "SELECT status, count(*) AS n FROM flow_runs GROUP BY status",
    );
    for (const row of runs.rows) {
      expect(res.body).toContain(`makerchecker_runs_total{status="${row.status}"} ${row.n}`);
    }

    const pending = await db.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM approvals WHERE status = 'pending'",
    );
    expect(res.body).toContain(`makerchecker_approvals_pending ${pending.rows[0]!.n}`);

    const audit = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM audit_events");
    expect(res.body).toContain(`makerchecker_audit_events_total ${audit.rows[0]!.n}`);

    expect(res.body).toContain(
      `makerchecker_webhook_failures_total ${webhookFailureCount()}`,
    );
    expect(res.body).toContain("# TYPE makerchecker_runs_total gauge");
    expect(res.body).toContain("# HELP makerchecker_approvals_pending");

    // Proxy decision counters: both series always present (even at zero) so a
    // denial spike is detectable from a flat baseline.
    const decisions = await db.pool.query<{ decision: string; n: string }>(
      "SELECT decision, count(*) AS n FROM proxy_actions GROUP BY decision",
    );
    const counts: Record<string, string> = { allowed: "0", denied: "0" };
    for (const r of decisions.rows) counts[r.decision] = r.n;
    expect(res.body).toContain(`makerchecker_proxy_decisions_total{decision="allowed"} ${counts.allowed}`);
    expect(res.body).toContain(`makerchecker_proxy_decisions_total{decision="denied"} ${counts.denied}`);
  });

  it("is absent unless MAKERCHECKER_METRICS=1 — exposure is an operator decision", async () => {
    delete process.env.MAKERCHECKER_METRICS;
    try {
      const dark = await buildApp(ctx);
      const res = await dark.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(404);
      await dark.close();
    } finally {
      process.env.MAKERCHECKER_METRICS = "1";
    }
  });
});
