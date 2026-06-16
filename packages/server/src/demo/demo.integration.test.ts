import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { buildApp } from "../app.js";
import { FlowValidationError, publishFlowVersion } from "../engine/flows.js";
import { GraphileWorkerBackend } from "../engine/graphile-backend.js";
import { createHandlers, type EngineContext } from "../engine/orchestrator.js";
import { generateApiKey } from "../auth/api-keys.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { SkillInvoker } from "../skills/invoker.js";
import { SequentialInvokerExecutor } from "../skills/sequential-executor.js";
import { demoLocalRegistry } from "./skills.js";
import { seedDemo } from "./seed.js";

const EXAMPLES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/daily-cash-reconciliation",
);
const AML_EXAMPLES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/aml-alert-triage",
);
const MDR_EXAMPLES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/mdr-reportability-triage",
);
const GTN_EXAMPLES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/gross-to-net-margin",
);
const COLD_CHAIN_EXAMPLES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/cold-chain-disposition",
);

let db: TestDb;
let ctx: EngineContext;
let app: Awaited<ReturnType<typeof buildApp>>;

let savedDemoDataDir: string | undefined;

beforeAll(async () => {
  // The demo suite exercises the engine, not auth; auth has its own suite
  // (api/admin.integration.test.ts). This mirrors compose demo mode.
  process.env.MAKERCHECKER_AUTH_DISABLED = "1";
  // The demo ingest skills confine reads to the parent of DEMO_DATA_DIR. The
  // suite triggers runs with explicit example paths under examples/, so point
  // DEMO_DATA_DIR inside examples/ so the root becomes examples/ and those
  // reads resolve in-root. Mirrors the compose default.
  savedDemoDataDir = process.env.DEMO_DATA_DIR;
  process.env.DEMO_DATA_DIR = EXAMPLES;
  db = await createTestDb();
  await seedDemo(db.pool);
  const backend = new GraphileWorkerBackend(db.pool, 5);
  const invoker = new SkillInvoker(db.pool, demoLocalRegistry());
  ctx = { pool: db.pool, backend, executor: new SequentialInvokerExecutor(invoker, db.pool) };
  await backend.start(createHandlers(ctx));
  app = await buildApp(ctx);
}, 60_000);

afterAll(async () => {
  delete process.env.MAKERCHECKER_AUTH_DISABLED;
  if (savedDemoDataDir !== undefined) process.env.DEMO_DATA_DIR = savedDemoDataDir;
  else delete process.env.DEMO_DATA_DIR;
  await app.close();
  await ctx.backend.stop();
  await db.drop();
});

async function waitForRunStatus(runId: string, statuses: string[], timeoutMs = 20_000) {
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

describe("seed", () => {
  it("is idempotent", async () => {
    await seedDemo(db.pool);
    const flows = await db.pool.query("SELECT count(*) AS n FROM flows");
    expect(Number(flows.rows[0].n)).toBe(8);
  });

  it("seeds two identities so identity-mode gates are decidable in the live demo", async () => {
    const users = await db.pool.query<{ email: string; is_admin: boolean }>(
      "SELECT email, is_admin FROM users WHERE email LIKE '%@makerchecker.local' ORDER BY email",
    );
    expect(users.rows).toEqual([
      { email: "admin@makerchecker.local", is_admin: true },
      { email: "officer@makerchecker.local", is_admin: false },
    ]);
    // Each has exactly one API key, even after re-seeding.
    const keys = await db.pool.query(
      `SELECT u.email, count(k.id) AS n FROM users u
         JOIN api_keys k ON k.user_id = u.id
        WHERE u.email LIKE '%@makerchecker.local'
        GROUP BY u.email ORDER BY u.email`,
    );
    expect(keys.rows.map((r: { n: string }) => Number(r.n))).toEqual([1, 1]);
  });
});

describe("Daily Cash Reconciliation — the flagship demo, end to end via the API", () => {
  let runId: string;

  it("triggers the flow through the API", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows/daily-cash-reconciliation/runs",
      payload: {
        input: {
          statementPath: join(EXAMPLES, "bank_statement.csv"),
          ledgerPath: join(EXAMPLES, "ledger.csv"),
        },
      },
    });
    expect(res.statusCode).toBe(201);
    runId = res.json().runId;
  });

  it("the preparer finds exactly the two planted exceptions, then parks at the gate", async () => {
    expect(await waitForRunStatus(runId, ["waiting_approval", "failed"])).toBe(
      "waiting_approval",
    );

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const prepare = detail.steps.find(
      (s: { step_key: string; status: string }) =>
        s.step_key === "prepare" && s.status === "completed",
    );
    expect(prepare.output.matchedCount).toBe(10);
    expect(prepare.output.exceptionCount).toBe(2);
    const types = prepare.output.exceptions.map((e: { type: string }) => e.type).sort();
    expect(types).toEqual(["amount_mismatch", "missing_in_ledger"]);
    const mismatch = prepare.output.exceptions.find(
      (e: { type: string }) => e.type === "amount_mismatch",
    );
    expect(mismatch).toMatchObject({ txnId: "T-1009", difference: -720 });

    // The post-gate step must not have run.
    expect(detail.steps.some((s: { step_key: string }) => s.step_key === "report")).toBe(false);
  });

  it("the approvals inbox lists the pending gate", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);
    expect(pending).toMatchObject({ flow: "daily-cash-reconciliation", step_key: "exception_review" });
  });

  it("approving through the API resumes the run; the reporter delivers via MCP", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);

    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}/decision`,
      payload: { decision: "approved", reason: "Both exceptions explained: Globex invoice typo, ref 88231 under investigation" },
    });
    expect(res.statusCode).toBe(200);

    expect(await waitForRunStatus(runId, ["completed", "failed"], 30_000)).toBe("completed");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const report = detail.steps.find((s: { step_key: string }) => s.step_key === "report");
    expect(report.status).toBe("completed");
    // notify@1 runs over REAL MCP stdio; its receipt is the step output.
    expect(report.output).toMatchObject({ delivered: true, channel: expect.any(String) });

    const eventTypes = detail.auditEvents.map((e: { event_type: string }) => e.event_type);
    // Every skill invocation is audited by the scripted executor (M11):
    // two skills per agent step land as skill.invoked between started/completed.
    expect(eventTypes).toEqual([
      "run.created",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "approval.requested",
      "approval.decided",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "run.completed",
    ]);
  }, 40_000);

  it("double-deciding the same approval is rejected with 409", async () => {
    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const approval = detail.approvals[0];
    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decision`,
      payload: { decision: "rejected" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("the audit chain verifies after the whole demo", async () => {
    const res = (await app.inject({ method: "GET", url: "/api/audit/verify" })).json();
    expect(res.ok).toBe(true);
    expect(res.count).toBeGreaterThan(10);
  });
});

describe("self-approval-attempt — the SoD demo", () => {
  it("is structurally blocked: preparer-role prepared, approver-role cannot act", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows/self-approval-attempt/runs",
      payload: {
        input: {
          statementPath: join(EXAMPLES, "bank_statement.csv"),
          ledgerPath: join(EXAMPLES, "ledger.csv"),
        },
      },
    });
    const runId = res.json().runId;
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("failed");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    expect(detail.run.failure_reason).toContain("segregation of duties");
    expect(
      detail.auditEvents.some(
        (e: { event_type: string }) => e.event_type === "enforcement.sod_violation",
      ),
    ).toBe(true);
  });
});

describe("high-value-payment — the n-of-m named approvals demo", () => {
  it("parks at a 2-approval gate that refuses unauthenticated decisions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows/high-value-payment/runs",
      payload: {
        input: {
          statementPath: join(EXAMPLES, "bank_statement.csv"),
          ledgerPath: join(EXAMPLES, "ledger.csv"),
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const runId = res.json().runId;
    expect(await waitForRunStatus(runId, ["waiting_approval", "failed"])).toBe(
      "waiting_approval",
    );

    // The inbox surfaces the required count for the dual-authorization gate.
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);
    expect(pending).toMatchObject({
      step_key: "dual_authorization",
      required_approvals: 2,
      approved_count: 0,
    });

    // Demo mode has no authenticated user — the identity gate FAILS CLOSED.
    const decide = await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}/decision`,
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(403);
    expect(decide.json().error).toContain("authenticated");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    expect(detail.run.status).toBe("waiting_approval");
    expect(detail.approvals[0].decisions).toEqual([]);
    expect(
      detail.auditEvents.some(
        (e: { event_type: string }) => e.event_type === "approval.decision_denied",
      ),
    ).toBe(true);
  });
});

describe("aml-alert-triage — the financial-crime demo, end to end via the API", () => {
  let runId: string;
  let officerAuth: Record<string, string>;

  beforeAll(async () => {
    // The BSA officer must be an authenticated user: the SAR gate is
    // identity-mode (forbid_requester), so anonymous decisions fail closed.
    const row = await db.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('bsa-officer@bank.example', 'x', 'BSA Officer') RETURNING id`,
    );
    const key = await generateApiKey(db.pool, {
      userId: row.rows[0]!.id,
      name: "bsa-officer-key",
    });
    officerAuth = { authorization: `Bearer ${key.plaintext}` };
  });

  it("the analyst role carries an enforced ingest cap the demo stays under", async () => {
    const { rows } = await db.pool.query<{ limits: Record<string, unknown> }>(
      "SELECT limits FROM roles WHERE name = 'aml-analyst-role'",
    );
    expect(rows[0]!.limits).toMatchObject({
      skills: { "alert-ingest@1": { maxInvocationsPerRun: 2 } },
    });
  });

  it("triggers the flow through the API and parks at the SAR gate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows/aml-alert-triage/runs",
      payload: { input: { alertsPath: join(AML_EXAMPLES, "alerts.csv") } },
    });
    expect(res.statusCode).toBe(201);
    runId = res.json().runId;
    expect(await waitForRunStatus(runId, ["waiting_approval", "failed"])).toBe(
      "waiting_approval",
    );
  });

  it("triage escalates exactly the two planted alerts, with rationales", async () => {
    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const triage = detail.steps.find(
      (s: { step_key: string; status: string }) =>
        s.step_key === "triage" && s.status === "completed",
    );
    expect(triage.output.alertCount).toBe(10);
    expect(triage.output.escalatedCount).toBe(2);
    const ids = triage.output.escalations.map((e: { alertId: string }) => e.alertId).sort();
    expect(ids).toEqual(["A-2005", "A-2007"]);
    const types = triage.output.escalations.map((e: { type: string }) => e.type).sort();
    expect(types).toEqual(["sanctions_near_match", "structuring"]);
    for (const e of triage.output.escalations) {
      expect(e.rationale).toBeTruthy();
    }

    // The post-gate step must not have run.
    expect(detail.steps.some((s: { step_key: string }) => s.step_key === "file")).toBe(false);
  });

  it("the inbox lists the BSA-officer gate as a single-approval identity gate", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);
    expect(pending).toMatchObject({
      flow: "aml-alert-triage",
      step_key: "sar_decision",
      required_approvals: 1,
      approved_count: 0,
    });
  });

  it("the BSA officer approves; SAR narratives are drafted and notified", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);

    // Identity gates demand an authenticated decision even in demo mode —
    // re-enable auth just for the officer's decision.
    delete process.env.MAKERCHECKER_AUTH_DISABLED;
    let decide;
    try {
      decide = await app.inject({
        method: "POST",
        url: `/api/approvals/${pending.id}/decision`,
        headers: officerAuth,
        payload: { decision: "approved", reason: "File SARs for A-2005 and A-2007" },
      });
    } finally {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    }
    expect(decide.statusCode).toBe(200);

    expect(await waitForRunStatus(runId, ["completed", "failed"], 30_000)).toBe("completed");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const file = detail.steps.find((s: { step_key: string }) => s.step_key === "file");
    expect(file.status).toBe("completed");
    // notify@1 runs over REAL MCP stdio; its receipt is the step output.
    expect(file.output).toMatchObject({ delivered: true, channel: "#aml" });

    // sar-draft@1 drafted one narrative per planted escalation.
    const sarEvents = detail.auditEvents.filter(
      (e: { event_type: string; payload: { skillRef?: string } }) =>
        e.event_type === "skill.invoked" && e.payload.skillRef === "sar-draft@1",
    );
    expect(sarEvents).toHaveLength(1);
    expect(sarEvents[0].payload.output.sarCount).toBe(2);

    // Full evidentiary sequence — and no enforcement.limit_violation: the
    // ingest cap (max 2/run) is present but the single invocation stays under.
    const eventTypes = detail.auditEvents.map((e: { event_type: string }) => e.event_type);
    expect(eventTypes).toEqual([
      "run.created",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "approval.requested",
      "approval.decided",
      "approval.resolved",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "run.completed",
    ]);
  }, 40_000);

  it("the audit chain verifies after the AML demo", async () => {
    const res = (await app.inject({ method: "GET", url: "/api/audit/verify" })).json();
    expect(res.ok).toBe(true);
  });
});

describe("mdr-reportability-triage — the medical-devices demo, end to end via the API", () => {
  let runId: string;
  let officerAuth: Record<string, string>;

  beforeAll(async () => {
    // The regulatory officer must be an authenticated user: the
    // reportability gate is identity-mode (forbid_requester), so anonymous
    // decisions fail closed.
    const row = await db.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('regulatory-officer@device.example', 'x', 'Regulatory Officer') RETURNING id`,
    );
    const key = await generateApiKey(db.pool, {
      userId: row.rows[0]!.id,
      name: "regulatory-officer-key",
    });
    officerAuth = { authorization: `Bearer ${key.plaintext}` };
  });

  it("the analyst role carries an enforced ingest cap the demo stays under", async () => {
    const { rows } = await db.pool.query<{ limits: Record<string, unknown> }>(
      "SELECT limits FROM roles WHERE name = 'complaint-analyst-role'",
    );
    expect(rows[0]!.limits).toMatchObject({
      skills: { "complaint-ingest@1": { maxInvocationsPerRun: 2 } },
    });
  });

  it("triggers the flow through the API and parks at the reportability gate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows/mdr-reportability-triage/runs",
      payload: { input: { complaintsPath: join(MDR_EXAMPLES, "complaints.csv") } },
    });
    expect(res.statusCode).toBe(201);
    runId = res.json().runId;
    expect(await waitForRunStatus(runId, ["waiting_approval", "failed"])).toBe(
      "waiting_approval",
    );
  });

  it("triage escalates exactly the two planted complaints, with the right clocks", async () => {
    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const triage = detail.steps.find(
      (s: { step_key: string; status: string }) =>
        s.step_key === "triage" && s.status === "completed",
    );
    expect(triage.output.complaintCount).toBe(10);
    expect(triage.output.escalatedCount).toBe(2);
    const ids = triage.output.escalations
      .map((e: { complaintId: string }) => e.complaintId)
      .sort();
    expect(ids).toEqual(["C-3004", "C-3008"]);
    const seriousInjury = triage.output.escalations.find(
      (e: { complaintId: string }) => e.complaintId === "C-3004",
    );
    expect(seriousInjury).toMatchObject({
      eventType: "serious_injury",
      clock: "30-day MDR (21 CFR 803.50)",
    });
    expect(seriousInjury.rationale).toContain("30-calendar-day");
    const malfunction = triage.output.escalations.find(
      (e: { complaintId: string }) => e.complaintId === "C-3008",
    );
    expect(malfunction).toMatchObject({
      eventType: "malfunction",
      recurrenceRisk: "high",
      clock: "30-day malfunction MDR (21 CFR 803.50)",
    });
    expect(malfunction.rationale).toContain("if it recurred");
    // The clearly-non-reportable complaints are cleared with rationales.
    expect(triage.output.cleared).toHaveLength(8);

    // The post-gate step must not have run.
    expect(detail.steps.some((s: { step_key: string }) => s.step_key === "file")).toBe(false);
  });

  it("the inbox lists the regulatory-officer gate as a single-approval identity gate", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);
    expect(pending).toMatchObject({
      flow: "mdr-reportability-triage",
      step_key: "reportability_decision",
      required_approvals: 1,
      approved_count: 0,
    });
  });

  it("the regulatory officer approves; MDR drafts are prepared and notified", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);

    // Identity gates demand an authenticated decision even in demo mode —
    // re-enable auth just for the officer's decision.
    delete process.env.MAKERCHECKER_AUTH_DISABLED;
    let decide;
    try {
      decide = await app.inject({
        method: "POST",
        url: `/api/approvals/${pending.id}/decision`,
        headers: officerAuth,
        payload: {
          decision: "approved",
          reason: "C-3004 and C-3008 are reportable; file MDRs within their clocks",
        },
      });
    } finally {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    }
    expect(decide.statusCode).toBe(200);

    expect(await waitForRunStatus(runId, ["completed", "failed"], 30_000)).toBe("completed");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const file = detail.steps.find((s: { step_key: string }) => s.step_key === "file");
    expect(file.status).toBe("completed");
    // notify@1 runs over REAL MCP stdio; its receipt is the step output.
    expect(file.output).toMatchObject({ delivered: true, channel: "#mdr" });

    // mdr-draft@1 drafted one MDR skeleton per planted escalation.
    const mdrEvents = detail.auditEvents.filter(
      (e: { event_type: string; payload: { skillRef?: string } }) =>
        e.event_type === "skill.invoked" && e.payload.skillRef === "mdr-draft@1",
    );
    expect(mdrEvents).toHaveLength(1);
    expect(mdrEvents[0].payload.output.mdrCount).toBe(2);

    // Full evidentiary sequence — and no enforcement.limit_violation: the
    // ingest cap (max 2/run) is present but the single invocation stays under.
    const eventTypes = detail.auditEvents.map((e: { event_type: string }) => e.event_type);
    expect(eventTypes).toEqual([
      "run.created",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "approval.requested",
      "approval.decided",
      "approval.resolved",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "run.completed",
    ]);
  }, 40_000);

  it("the requester is forbidden from deciding their own reportability gate", async () => {
    // Trigger AS the officer (authenticated requester), then have the same
    // user attempt the decision: forbid_requester denies with 403 — the
    // analyst-cannot-decide-reportability control firing on a human.
    delete process.env.MAKERCHECKER_AUTH_DISABLED;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/flows/mdr-reportability-triage/runs",
        headers: officerAuth,
        payload: { input: { complaintsPath: join(MDR_EXAMPLES, "complaints.csv") } },
      });
      expect(res.statusCode).toBe(201);
      const requesterRunId = res.json().runId;
      expect(await waitForRunStatus(requesterRunId, ["waiting_approval", "failed"])).toBe(
        "waiting_approval",
      );

      const inbox = (
        await app.inject({ method: "GET", url: "/api/approvals", headers: officerAuth })
      ).json();
      const pending = inbox.approvals.find(
        (a: { run_id: string }) => a.run_id === requesterRunId,
      );
      const decide = await app.inject({
        method: "POST",
        url: `/api/approvals/${pending.id}/decision`,
        headers: officerAuth,
        payload: { decision: "approved" },
      });
      expect(decide.statusCode).toBe(403);
      expect(decide.json().error).toContain("triggered this run");

      const detail = (
        await app.inject({
          method: "GET",
          url: `/api/runs/${requesterRunId}`,
          headers: officerAuth,
        })
      ).json();
      expect(detail.run.status).toBe("waiting_approval");
      expect(detail.approvals[0].decisions).toEqual([]);
      expect(
        detail.auditEvents.some(
          (e: { event_type: string; payload: { code?: string } }) =>
            e.event_type === "approval.decision_denied" &&
            e.payload.code === "requester_forbidden",
        ),
      ).toBe(true);
    } finally {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    }
  });

  it("the audit chain verifies after the MDR demo", async () => {
    const res = (await app.inject({ method: "GET", url: "/api/audit/verify" })).json();
    expect(res.ok).toBe(true);
  });
});

describe("pv-icsr-processing — the medicines demo, end to end via the API", () => {
  let runId: string;
  let reviewerAuth: Record<string, string>;
  let savedDataDir: string | undefined;

  beforeAll(async () => {
    // The medical reviewer must be an authenticated user: the medical-review
    // gate is identity-mode (forbid_requester), so anonymous decisions fail
    // closed.
    const row = await db.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('medical-reviewer@pharma.example', 'x', 'Medical Reviewer') RETURNING id`,
    );
    const key = await generateApiKey(db.pool, {
      userId: row.rows[0]!.id,
      name: "medical-reviewer-key",
    });
    reviewerAuth = { authorization: `Bearer ${key.plaintext}` };

    // This demo proves the DEMO_DATA_DIR sibling convention: the trigger
    // sends NO path, and case-intake resolves the fixture as a sibling of
    // the recon data dir — exactly how the docker image is wired.
    savedDataDir = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = EXAMPLES;
  });

  afterAll(() => {
    if (savedDataDir !== undefined) process.env.DEMO_DATA_DIR = savedDataDir;
    else delete process.env.DEMO_DATA_DIR;
  });

  it("the processor role carries an enforced intake cap the demo stays under", async () => {
    const { rows } = await db.pool.query<{ limits: Record<string, unknown> }>(
      "SELECT limits FROM roles WHERE name = 'pv-case-processor-role'",
    );
    expect(rows[0]!.limits).toMatchObject({
      skills: { "case-intake@1": { maxInvocationsPerRun: 2 } },
    });
  });

  it("triggers with an empty body (DEMO_DATA_DIR sibling default) and parks at the gate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows/pv-icsr-processing/runs",
      payload: { input: {} },
    });
    expect(res.statusCode).toBe(201);
    runId = res.json().runId;
    expect(await waitForRunStatus(runId, ["waiting_approval", "failed"])).toBe(
      "waiting_approval",
    );
  });

  it("triage expedites exactly the two planted cases, with the 15-day clock", async () => {
    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const triage = detail.steps.find(
      (s: { step_key: string; status: string }) =>
        s.step_key === "intake_triage" && s.status === "completed",
    );
    expect(triage.output.caseCount).toBe(10);
    expect(triage.output.expeditedCount).toBe(2);
    const ids = triage.output.expedited.map((c: { caseId: string }) => c.caseId).sort();
    expect(ids).toEqual(["P-4003", "P-4009"]);
    for (const c of triage.output.expedited) {
      expect(c).toMatchObject({
        seriousness: "serious",
        expectedness: "unexpected",
        clock: "15-day expedited (21 CFR 314.80)",
      });
      expect(c.rationale).toContain("serious and unexpected");
    }
    // P-4009 arrived from Germany — the expedited clock is source-independent.
    const foreign = triage.output.expedited.find(
      (c: { caseId: string }) => c.caseId === "P-4009",
    );
    expect(foreign.country).toBe("DE");
    // Serious-but-expected and non-serious cases route to periodic reporting.
    expect(triage.output.periodic).toHaveLength(8);

    // The post-gate step must not have run.
    expect(detail.steps.some((s: { step_key: string }) => s.step_key === "submit")).toBe(false);
  });

  it("the inbox lists the medical-review gate as a single-approval identity gate", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);
    expect(pending).toMatchObject({
      flow: "pv-icsr-processing",
      step_key: "medical_review",
      required_approvals: 1,
      approved_count: 0,
    });
  });

  it("the medical reviewer approves; ICSR narratives are drafted and notified", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);

    // Identity gates demand an authenticated decision even in demo mode —
    // re-enable auth just for the reviewer's decision.
    delete process.env.MAKERCHECKER_AUTH_DISABLED;
    let decide;
    try {
      decide = await app.inject({
        method: "POST",
        url: `/api/approvals/${pending.id}/decision`,
        headers: reviewerAuth,
        payload: {
          decision: "approved",
          reason: "Seriousness and expectedness confirmed for P-4003 and P-4009",
        },
      });
    } finally {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    }
    expect(decide.statusCode).toBe(200);

    expect(await waitForRunStatus(runId, ["completed", "failed"], 30_000)).toBe("completed");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const submit = detail.steps.find((s: { step_key: string }) => s.step_key === "submit");
    expect(submit.status).toBe("completed");
    // notify@1 runs over REAL MCP stdio; its receipt is the step output.
    expect(submit.output).toMatchObject({ delivered: true, channel: "#pv" });

    // narrative-draft@1 drafted one narrative per planted expedited case.
    const draftEvents = detail.auditEvents.filter(
      (e: { event_type: string; payload: { skillRef?: string } }) =>
        e.event_type === "skill.invoked" && e.payload.skillRef === "narrative-draft@1",
    );
    expect(draftEvents).toHaveLength(1);
    expect(draftEvents[0].payload.output.icsrCount).toBe(2);

    // Full evidentiary sequence — and no enforcement.limit_violation: the
    // intake cap (max 2/run) is present but the single invocation stays under.
    const eventTypes = detail.auditEvents.map((e: { event_type: string }) => e.event_type);
    expect(eventTypes).toEqual([
      "run.created",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "approval.requested",
      "approval.decided",
      "approval.resolved",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "run.completed",
    ]);
  }, 40_000);

  it("the audit chain verifies after the PV demo", async () => {
    const res = (await app.inject({ method: "GET", url: "/api/audit/verify" })).json();
    expect(res.ok).toBe(true);
  });
});

describe("gross-to-net-margin — the pharma/medtech commercial demo, end to end via the API", () => {
  let runId: string;
  let controllerAuth: Record<string, string>;

  beforeAll(async () => {
    // The finance controller must be an authenticated user: the margin
    // certification gate is identity-mode (forbid_requester), so anonymous
    // decisions fail closed.
    const row = await db.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('finance-controller@pharma.example', 'x', 'Finance Controller') RETURNING id`,
    );
    const key = await generateApiKey(db.pool, {
      userId: row.rows[0]!.id,
      name: "finance-controller-key",
    });
    controllerAuth = { authorization: `Bearer ${key.plaintext}` };
  });

  it("the analyst role carries an enforced extract cap the demo stays under", async () => {
    const { rows } = await db.pool.query<{ limits: Record<string, unknown> }>(
      "SELECT limits FROM roles WHERE name = 'gtn-analyst-role'",
    );
    expect(rows[0]!.limits).toMatchObject({
      skills: { "erp-extract@1": { maxInvocationsPerRun: 2 } },
    });
  });

  it("the finance controller's role carries no limits — it only certifies", async () => {
    const { rows } = await db.pool.query<{ limits: Record<string, unknown> }>(
      "SELECT limits FROM roles WHERE name = 'finance-controller-role'",
    );
    expect(rows[0]!.limits).toEqual({});
  });

  it("triggers the flow through the API and parks at the certification gate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows/gross-to-net-margin/runs",
      payload: { input: { pricingPath: join(GTN_EXAMPLES, "erp_pricing.csv") } },
    });
    expect(res.statusCode).toBe(201);
    runId = res.json().runId;
    expect(await waitForRunStatus(runId, ["waiting_approval", "failed"])).toBe(
      "waiting_approval",
    );
  });

  it("the waterfall flags EXACTLY the one planted data-integrity anomaly", async () => {
    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const build = detail.steps.find(
      (s: { step_key: string; status: string }) =>
        s.step_key === "build" && s.status === "completed",
    );
    // Twelve ERP rows across three markets; eleven clean, exactly one flagged.
    expect(build.output.rowCount).toBe(12);
    expect(build.output.cleanCount).toBe(11);
    expect(build.output.exceptionCount).toBe(1);

    const exc = build.output.exceptions[0];
    expect(exc).toMatchObject({
      market: "DE",
      sku: "PUMP-MX",
      type: "data_integrity_exception",
    });
    // The double-counted austerity discount pushes total deductions past 100%
    // of list, producing an impossible negative net — the wrong number the org
    // would otherwise post.
    expect(exc.totalDeductionPct).toBeCloseTo(1.22, 5);
    expect(exc.netPrice).toBe(-748);
    expect(exc.netPrice).toBeLessThanOrEqual(0);
    expect(exc.rationale).toContain("exceeds 100% of list");
    expect(exc.rationale).toContain("austerity");

    // The flagged DE/PUMP-MX row is excluded from the clean comparable view;
    // the other (clean) PUMP-MX rows in US and JP remain.
    const cleanPump = build.output.rows.filter((r: { sku: string }) => r.sku === "PUMP-MX");
    expect(cleanPump.map((r: { market: string }) => r.market).sort()).toEqual(["JP", "US"]);
    expect(build.output.rows).toHaveLength(11);

    // Every market appears in the consolidated, normalized cross-market summary.
    const markets = build.output.perMarket.map((m: { market: string }) => m.market).sort();
    expect(markets).toEqual(["DE", "JP", "US"]);
    expect(build.output.consolidated.markets).toBe(3);
    expect(build.output.consolidated.netMarginPct).toBeGreaterThan(0);
    expect(build.output.consolidated.netMarginPct).toBeLessThan(1);

    // The post-gate step must not have run.
    expect(detail.steps.some((s: { step_key: string }) => s.step_key === "certify")).toBe(false);
  });

  it("the inbox lists the controller gate as a single-approval identity gate", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);
    expect(pending).toMatchObject({
      flow: "gross-to-net-margin",
      step_key: "margin_certification",
      required_approvals: 1,
      approved_count: 0,
    });
  });

  it("the requester is forbidden from certifying their own margin gate", async () => {
    // Trigger AS the controller (authenticated requester), then have the same
    // user attempt the certification: forbid_requester denies with 403 — the
    // analyst-cannot-certify control firing on a human.
    delete process.env.MAKERCHECKER_AUTH_DISABLED;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/flows/gross-to-net-margin/runs",
        headers: controllerAuth,
        payload: { input: { pricingPath: join(GTN_EXAMPLES, "erp_pricing.csv") } },
      });
      expect(res.statusCode).toBe(201);
      const requesterRunId = res.json().runId;
      expect(await waitForRunStatus(requesterRunId, ["waiting_approval", "failed"])).toBe(
        "waiting_approval",
      );

      const inbox = (
        await app.inject({ method: "GET", url: "/api/approvals", headers: controllerAuth })
      ).json();
      const pending = inbox.approvals.find(
        (a: { run_id: string }) => a.run_id === requesterRunId,
      );
      const decide = await app.inject({
        method: "POST",
        url: `/api/approvals/${pending.id}/decision`,
        headers: controllerAuth,
        payload: { decision: "approved" },
      });
      expect(decide.statusCode).toBe(403);
      expect(decide.json().error).toContain("triggered this run");

      const detail = (
        await app.inject({
          method: "GET",
          url: `/api/runs/${requesterRunId}`,
          headers: controllerAuth,
        })
      ).json();
      expect(detail.run.status).toBe("waiting_approval");
      expect(detail.approvals[0].decisions).toEqual([]);
      expect(
        detail.auditEvents.some(
          (e: { event_type: string; payload: { code?: string } }) =>
            e.event_type === "approval.decision_denied" &&
            e.payload.code === "requester_forbidden",
        ),
      ).toBe(true);
    } finally {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    }
  });

  it("the finance controller certifies; the rebate accrual is drafted and notified", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);

    // Identity gates demand an authenticated decision even in demo mode —
    // re-enable auth just for the controller's decision.
    delete process.env.MAKERCHECKER_AUTH_DISABLED;
    let decide;
    try {
      decide = await app.inject({
        method: "POST",
        url: `/api/approvals/${pending.id}/decision`,
        headers: controllerAuth,
        payload: {
          decision: "approved",
          reason: "Comparable view certified; DE/PUMP-MX excluded pending ERP correction",
        },
      });
    } finally {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    }
    expect(decide.statusCode).toBe(200);

    expect(await waitForRunStatus(runId, ["completed", "failed"], 30_000)).toBe("completed");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const certify = detail.steps.find((s: { step_key: string }) => s.step_key === "certify");
    expect(certify.status).toBe("completed");
    // notify@1 runs over REAL MCP stdio; its receipt is the step output.
    expect(certify.output).toMatchObject({ delivered: true, channel: "#finance" });

    // accrual-draft@1 produced one rebate accrual per market in the view.
    const accrualEvents = detail.auditEvents.filter(
      (e: { event_type: string; payload: { skillRef?: string } }) =>
        e.event_type === "skill.invoked" && e.payload.skillRef === "accrual-draft@1",
    );
    expect(accrualEvents).toHaveLength(1);
    expect(accrualEvents[0].payload.output.accrualCount).toBe(3);

    // Full evidentiary sequence — including approval.resolved — and no
    // enforcement.limit_violation: the extract cap (max 2/run) is present but
    // the single invocation stays under.
    const eventTypes = detail.auditEvents.map((e: { event_type: string }) => e.event_type);
    expect(eventTypes).toEqual([
      "run.created",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "approval.requested",
      "approval.decided",
      "approval.resolved",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "run.completed",
    ]);
  }, 40_000);

  it("the audit chain verifies after the gross-to-net demo", async () => {
    const res = (await app.inject({ method: "GET", url: "/api/audit/verify" })).json();
    expect(res.ok).toBe(true);
  });
});

describe("cold-chain-disposition — the safe/consequential asymmetry demo, end to end via the API", () => {
  let runId: string;
  let qaAuth: Record<string, string>;

  beforeAll(async () => {
    // The QA releaser must be an authenticated user: the disposition gate is
    // identity-mode (forbid_requester), so anonymous decisions fail closed.
    const row = await db.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('qa-release@biologics.example', 'x', 'QA Release') RETURNING id`,
    );
    const key = await generateApiKey(db.pool, { userId: row.rows[0]!.id, name: "qa-release-key" });
    qaAuth = { authorization: `Bearer ${key.plaintext}` };
  });

  it("the monitor role carries an enforced ingest cap the demo stays under; QA has none", async () => {
    const monitor = await db.pool.query<{ limits: Record<string, unknown> }>(
      "SELECT limits FROM roles WHERE name = 'cold-chain-monitor-role'",
    );
    expect(monitor.rows[0]!.limits).toMatchObject({
      skills: { "excursion-ingest@1": { maxInvocationsPerRun: 2 } },
    });
    const qa = await db.pool.query<{ limits: Record<string, unknown> }>(
      "SELECT limits FROM roles WHERE name = 'qa-release-role'",
    );
    expect(qa.rows[0]!.limits).toEqual({});
  });

  it("the disposition-act skill is high-risk — the tier that structurally forces the gate", async () => {
    const { rows } = await db.pool.query<{ risk_tier: string }>(
      "SELECT risk_tier FROM skills WHERE name = 'disposition-act' AND version = 1",
    );
    expect(rows[0]!.risk_tier).toBe("high");
  });

  it("triggers the flow through the API and parks at the QA disposition gate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows/cold-chain-disposition/runs",
      payload: {
        input: {
          excursionsPath: join(COLD_CHAIN_EXAMPLES, "excursions.csv"),
          limitsPath: join(COLD_CHAIN_EXAMPLES, "stability_limits.csv"),
          readingsPath: join(COLD_CHAIN_EXAMPLES, "readings.csv"),
        },
      },
    });
    expect(res.statusCode).toBe(201);
    runId = res.json().runId;
    expect(await waitForRunStatus(runId, ["waiting_approval", "failed"])).toBe("waiting_approval");
  });

  it("the agent quarantines the affected lots ITSELF, pre-gate — the safe direction is ungated", async () => {
    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const assess = detail.steps.find(
      (s: { step_key: string; status: string }) =>
        s.step_key === "assess" && s.status === "completed",
    );
    // The single affected lot, assessed and quarantined before the gate.
    expect(assess.output.held).toBe(true);
    expect(assess.output.heldUnits).toBe(9800);
    expect(assess.output.holdList).toEqual(["LOT-5002"]);

    // quarantine@1 ran inside the pre-gate step — proof the agent moved toward
    // safety on its own, with no approval.
    const quarantineEvents = detail.auditEvents.filter(
      (e: { event_type: string; payload: { skillRef?: string } }) =>
        e.event_type === "skill.invoked" && e.payload.skillRef === "quarantine@1",
    );
    expect(quarantineEvents).toHaveLength(1);
    expect(quarantineEvents[0].payload.output.held).toBe(true);

    // The incident is assessed from the datalogger trace: peak 15 °C against an
    // 8 °C limit, 180 minutes over limit — beyond validated stability, destroy.
    expect(assess.output).toMatchObject({
      peakTempC: 15,
      minutesOverLimit: 180,
      classification: "beyond",
      recommendedDisposition: "destroy",
      limitC: 8,
    });
    expect(assess.output.readings).toHaveLength(13);

    // The agent wrote a cited incident report — the artifact QA signs against.
    expect(assess.output.report.title).toBe("Cold-Chain Incident Report");
    expect(assess.output.report.body).toHaveLength(3);
    expect(assess.output.report.footnotes).toHaveLength(3);

    // The high-risk, gated act step has NOT run.
    expect(detail.steps.some((s: { step_key: string }) => s.step_key === "act")).toBe(false);
    // disposition-act@1 never fired pre-gate.
    expect(
      detail.auditEvents.some(
        (e: { event_type: string; payload: { skillRef?: string } }) =>
          e.event_type === "skill.invoked" && e.payload.skillRef === "disposition-act@1",
      ),
    ).toBe(false);
  });

  it("the inbox lists the QA gate as a single-approval identity gate", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);
    expect(pending).toMatchObject({
      flow: "cold-chain-disposition",
      step_key: "disposition_decision",
      required_approvals: 1,
      approved_count: 0,
    });
  });

  it("the monitor who triggered the run is forbidden from owning its disposition", async () => {
    // forbid_requester denies an anonymous decision in demo mode — fail closed.
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);
    const decide = await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}/decision`,
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(403);
    expect(decide.json().error).toContain("authenticated");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    expect(detail.run.status).toBe("waiting_approval");
    expect(detail.approvals[0].decisions).toEqual([]);
    expect(
      detail.auditEvents.some(
        (e: { event_type: string }) => e.event_type === "approval.decision_denied",
      ),
    ).toBe(true);
  });

  it("the QA releaser decides the one-way door; disposition-act runs only after the gate", async () => {
    const inbox = (await app.inject({ method: "GET", url: "/api/approvals" })).json();
    const pending = inbox.approvals.find((a: { run_id: string }) => a.run_id === runId);

    // Identity gates demand an authenticated decision even in demo mode —
    // re-enable auth just for the QA decision.
    delete process.env.MAKERCHECKER_AUTH_DISABLED;
    let decide;
    try {
      decide = await app.inject({
        method: "POST",
        url: `/api/approvals/${pending.id}/decision`,
        headers: qaAuth,
        payload: {
          decision: "approved",
          reason: "Destroy the lot: beyond validated stability per the datalogger trace",
        },
      });
    } finally {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    }
    expect(decide.statusCode).toBe(200);

    expect(await waitForRunStatus(runId, ["completed", "failed"], 30_000)).toBe("completed");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const act = detail.steps.find((s: { step_key: string }) => s.step_key === "act");
    expect(act.status).toBe("completed");
    // notify@1 runs over REAL MCP stdio; its receipt is the step output.
    expect(act.output).toMatchObject({ delivered: true, channel: "#cold-chain" });

    // disposition-act@1 executed exactly once, ONLY after the gate: the single
    // beyond-spec lot is destroyed per the QA decision.
    const actEvents = detail.auditEvents.filter(
      (e: { event_type: string; payload: { skillRef?: string } }) =>
        e.event_type === "skill.invoked" && e.payload.skillRef === "disposition-act@1",
    );
    expect(actEvents).toHaveLength(1);
    expect(actEvents[0].payload.output).toMatchObject({
      releasedCount: 0,
      destroyedCount: 1,
      heldForJudgmentCount: 0,
    });

    // Full evidentiary sequence: the assess step records THREE skill.invoked
    // (excursion-ingest, stability-assess, quarantine) before the gate, then the
    // act step records TWO (disposition-act, notify) after it. The
    // approval.decision_denied is the requester's forbidden attempt (the prior
    // test) — faithfully recorded in the chain before the valid QA decision. No
    // enforcement.limit_violation: the ingest cap (max 2/run) stays under.
    const eventTypes = detail.auditEvents.map((e: { event_type: string }) => e.event_type);
    expect(eventTypes).toEqual([
      "run.created",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "approval.requested",
      "approval.decision_denied",
      "approval.decided",
      "approval.resolved",
      "run.step.started",
      "skill.invoked",
      "skill.invoked",
      "run.step.completed",
      "run.completed",
    ]);
  }, 40_000);

  it("the audit chain verifies after the cold-chain demo", async () => {
    const res = (await app.inject({ method: "GET", url: "/api/audit/verify" })).json();
    expect(res.ok).toBe(true);
  });

  it("rejects publishing a flow that uses the high-risk disposition-act WITHOUT a preceding gate", async () => {
    // The headline structural guarantee: the one-way door cannot be wired into a
    // flow ungated. Same agent, same high-risk skill, but no approval gate before
    // the step that uses it — publish must fail with high_risk_requires_gate.
    const publish = publishFlowVersion(db.pool, {
      actor: { type: "system", id: "test", name: "test" },
      definition: {
        name: "cold-chain-disposition-ungated",
        steps: [
          {
            key: "assess",
            agent: "cold-chain-monitor",
            skills: ["excursion-ingest@1", "stability-assess@1", "quarantine@1"],
          },
          {
            // No approval gate precedes this step — the high-risk skill is exposed.
            key: "act",
            agent: "cold-chain-monitor",
            skills: ["disposition-act@1", "notify@1"],
          },
        ],
      },
    });
    await expect(publish).rejects.toThrow(FlowValidationError);
    await expect(publish).rejects.toThrow(/high-risk.*approval gate/);

    // The rejected flow was never persisted.
    const exists = await db.pool.query("SELECT 1 FROM flows WHERE name = $1", [
      "cold-chain-disposition-ungated",
    ]);
    expect(exists.rows).toHaveLength(0);
  });
});

describe("API edge cases", () => {
  it("triggers with an empty body (input defaults apply)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/flows/self-approval-attempt/runs" });
    expect(res.statusCode).toBe(201);
  });

  it("404s unknown flows and runs, validates decisions", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/flows/nope/runs", payload: {} })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/runs/00000000-0000-0000-0000-000000000000",
        })
      ).statusCode,
    ).toBe(404);
    const bad = await app.inject({
      method: "POST",
      url: "/api/approvals/00000000-0000-0000-0000-000000000000/decision",
      payload: { decision: "maybe" },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/api/approvals/00000000-0000-0000-0000-000000000000/decision",
      payload: { decision: "approved" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("password hashing", () => {
  it("round-trips and rejects wrong passwords and malformed hashes", async () => {
    const hash = await hashPassword("makerchecker-demo");
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword("makerchecker-demo", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    // Unique salts: same password, different hashes.
    expect(await hashPassword("makerchecker-demo")).not.toBe(hash);
  });
});
