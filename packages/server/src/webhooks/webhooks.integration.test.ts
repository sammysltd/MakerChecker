import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { GraphileWorkerBackend } from "../engine/graphile-backend.js";
import { LocalSkillExecutor, type LocalSkillFn } from "../engine/executor.js";
import { publishFlowVersion } from "../engine/flows.js";
import {
  createHandlers,
  decideApproval,
  startRun,
  type EngineContext,
} from "../engine/orchestrator.js";
import { notifyWebhooks, signWebhookBody, webhookFailureCount } from "./dispatcher.js";

interface Delivery {
  path: string;
  signature: string;
  body: string;
  parsed: { event: string; runId: string; data: Record<string, unknown>; occurredAt: string };
}

const GOOD_SECRET = "good-endpoint-secret";
const DISABLED_SECRET = "disabled-endpoint-secret";
const USER = { type: "user" as const, id: "wh-user", name: "Webhook Tester" };

let db: TestDb;
let ctx: EngineContext;
let receiver: Server;
let failer: Server;
let receiverUrl: string;
let deadUrl: string;
let flowVersionId: string;
let failingFlowVersionId: string;
const deliveries: Delivery[] = [];
const registry = new Map<string, LocalSkillFn>();
const PREV_ALLOW_PRIVATE = process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function waitForDelivery(
  predicate: (d: Delivery) => boolean,
  timeoutMs = 10_000,
): Promise<Delivery> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = deliveries.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(
        `no matching delivery; saw: ${deliveries.map((d) => d.parsed.event).join(", ")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
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

beforeAll(async () => {
  // This suite POSTs to a real http server on 127.0.0.1; opt the dispatcher's
  // SSRF egress guard in for the test process only (production never sets this).
  process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
  db = await createTestDb();

  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      deliveries.push({
        path: req.url ?? "/",
        signature: String(req.headers["x-makerchecker-signature"]),
        body,
        parsed: JSON.parse(body) as Delivery["parsed"],
      });
      res.writeHead(204).end();
    });
  });
  receiverUrl = await listen(receiver);

  // An endpoint that is up but always errors: must be logged, never fatal.
  failer = createServer((_req, res) => res.writeHead(500).end());
  const failerUrl = await listen(failer);

  // A dead endpoint: connection refused.
  const ghost = createServer(() => {});
  deadUrl = await listen(ghost);
  await new Promise((resolve) => ghost.close(resolve));

  await db.pool.query(
    `INSERT INTO webhook_endpoints (url, secret, enabled) VALUES
       ($1, $2, true),   -- healthy, signed deliveries land here
       ($3, $4, false),  -- disabled: must never be called
       ($5, 'dead-secret', true),
       ($6, 'failer-secret', true)`,
    [receiverUrl, GOOD_SECRET, `${receiverUrl}/disabled`, DISABLED_SECRET, deadUrl, failerUrl],
  );

  // Minimal governed flow: prepare -> gate -> report.
  await db.pool.query("INSERT INTO roles (name) VALUES ('wh-role')");
  await db.pool.query(
    `INSERT INTO agents (name, role_id) SELECT 'wh-agent', id FROM roles WHERE name = 'wh-role'`,
  );
  await db.pool.query(
    `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
     VALUES ('wh-skill', 1, '{}', '{}', '{"type":"local"}', 'low'),
            ('wh-bomb', 1, '{}', '{}', '{"type":"local"}', 'low')`,
  );
  await db.pool.query(
    `INSERT INTO role_skill_grants (role_id, skill_id)
     SELECT r.id, s.id FROM roles r, skills s WHERE r.name = 'wh-role'`,
  );
  registry.set("wh-skill@1", async (input) => ({ ...input, done: true }));
  registry.set("wh-bomb@1", async () => {
    throw new Error("boom");
  });

  const flow = await publishFlowVersion(db.pool, {
    actor: USER,
    definition: {
      name: "wh-flow",
      steps: [
        { key: "prepare", agent: "wh-agent", skills: ["wh-skill@1"] },
        { key: "gate", type: "approval_gate", title: "Check it" },
        { key: "report", agent: "wh-agent", skills: ["wh-skill@1"] },
      ],
    },
  });
  flowVersionId = flow.flowVersionId;

  const failing = await publishFlowVersion(db.pool, {
    actor: USER,
    definition: {
      name: "wh-failing-flow",
      steps: [{ key: "explode", agent: "wh-agent", skills: ["wh-bomb@1"] }],
    },
  });
  failingFlowVersionId = failing.flowVersionId;

  const backend = new GraphileWorkerBackend(db.pool, 5);
  ctx = { pool: db.pool, backend, executor: new LocalSkillExecutor(registry) };
  await backend.start(createHandlers(ctx));
}, 60_000);

afterAll(async () => {
  await ctx.backend.stop();
  await new Promise((resolve) => receiver.close(resolve));
  await new Promise((resolve) => failer.close(resolve));
  await db.drop();
  if (PREV_ALLOW_PRIVATE === undefined) delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
  else process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = PREV_ALLOW_PRIVATE;
});

describe("dispatcher unit behaviour", () => {
  it("signs bodies as sha256=<hmac-hex>", () => {
    const sig = signWebhookBody("s3cret", '{"a":1}');
    expect(sig).toBe(`sha256=${createHmac("sha256", "s3cret").update('{"a":1}').digest("hex")}`);
  });

  it("survives a broken pool (endpoint query failure is swallowed)", async () => {
    const broken = new pg.Pool({ connectionString: db.databaseUrl });
    await broken.end();
    await expect(
      notifyWebhooks(broken, "x.test", { runId: "r", data: {} }),
    ).resolves.toBeUndefined();
  });

  it("blocks delivery to a private/loopback endpoint when the allow-flag is off (SSRF guard)", async () => {
    // The receiver listens on 127.0.0.1, so its URL is private/loopback. With the
    // allow-flag off, the SSRF guard must skip the POST entirely (no delivery
    // lands, and the failure counter is bumped) rather than calling the internal
    // address. Toggle the flag off only for this case, then restore it.
    process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "0";
    const failuresBefore = webhookFailureCount();
    const ssrfRunId = `ssrf-${Date.now()}`;
    try {
      await notifyWebhooks(db.pool, "ssrf.probe", { runId: ssrfRunId, data: {} });
    } finally {
      process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
    }
    // Nothing was POSTed for this event (the loopback receiver never saw it).
    const blocked = deliveries.find((d) => d.parsed.runId === ssrfRunId);
    expect(blocked).toBeUndefined();
    // The blocked endpoint(s) were counted as failures.
    expect(webhookFailureCount()).toBeGreaterThan(failuresBefore);
  });
});

describe("engine-driven deliveries", () => {
  let runId: string;

  it("delivers approval.requested with a verifiable HMAC signature", async () => {
    runId = await startRun(ctx, { flowVersionId, triggeredBy: USER, runInput: { v: 1 } });
    expect(await waitForRunStatus(runId, ["waiting_approval", "failed"])).toBe(
      "waiting_approval",
    );

    const delivery = await waitForDelivery(
      (d) => d.parsed.event === "approval.requested" && d.parsed.runId === runId,
    );
    expect(delivery.path).toBe("/");
    expect(delivery.parsed.data).toMatchObject({ stepKey: "gate", title: "Check it" });
    expect(delivery.parsed.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Independent HMAC verification, the way a consumer would do it.
    expect(delivery.signature).toBe(
      `sha256=${createHmac("sha256", GOOD_SECRET).update(delivery.body).digest("hex")}`,
    );
  });

  it("delivers run.finished after approval — engine unharmed by dead and 500 endpoints", async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      "SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'",
      [runId],
    );
    await decideApproval(ctx, {
      approvalId: rows[0]!.id,
      decision: "approved",
      decidedBy: USER,
    });

    // The run completes even though two of the enabled endpoints are broken.
    expect(await waitForRunStatus(runId, ["completed", "failed"])).toBe("completed");
    const delivery = await waitForDelivery(
      (d) => d.parsed.event === "run.finished" && d.parsed.runId === runId,
    );
    expect(delivery.parsed.data).toEqual({ status: "completed" });
  });

  it("delivers run.failed when an approval is rejected", async () => {
    const rejectedRun = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    await waitForRunStatus(rejectedRun, ["waiting_approval"]);
    const { rows } = await db.pool.query<{ id: string }>(
      "SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'",
      [rejectedRun],
    );
    await decideApproval(ctx, {
      approvalId: rows[0]!.id,
      decision: "rejected",
      decidedBy: USER,
      reason: "not today",
    });
    await waitForRunStatus(rejectedRun, ["failed"]);

    const delivery = await waitForDelivery(
      (d) => d.parsed.event === "run.failed" && d.parsed.runId === rejectedRun,
    );
    expect(String(delivery.parsed.data.reason)).toContain("rejected");
  });

  it("delivers run.failed when a step exhausts its attempts", async () => {
    const failedRun = await startRun(ctx, {
      flowVersionId: failingFlowVersionId,
      triggeredBy: USER,
    });
    expect(await waitForRunStatus(failedRun, ["completed", "failed"])).toBe("failed");

    const delivery = await waitForDelivery(
      (d) => d.parsed.event === "run.failed" && d.parsed.runId === failedRun,
    );
    expect(String(delivery.parsed.data.reason)).toContain("boom");
    expect(delivery.signature).toBe(signWebhookBody(GOOD_SECRET, delivery.body));
  });

  it("redacts a PII-bearing run.failed reason on the OUTBOUND webhook (egress redaction)", async () => {
    // Webhooks are an egress seam — the configured redaction hook must mask the
    // skill-error-derived reason before it is POSTed to an external endpoint.
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('wh-bomb-pii', 1, '{}', '{}', '{"type":"local"}', 'low')`,
    );
    await db.pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s
        WHERE r.name = 'wh-role' AND s.name = 'wh-bomb-pii' AND s.version = 1`,
    );
    registry.set("wh-bomb-pii@1", async () => {
      throw new Error("wire to leak@private.test (acct 4012888888881881) failed");
    });
    const f = await publishFlowVersion(db.pool, {
      actor: USER,
      definition: {
        name: "wh-failing-pii-flow",
        steps: [{ key: "explode", agent: "wh-agent", skills: ["wh-bomb-pii@1"] }],
      },
    });

    process.env.MAKERCHECKER_REDACTION = "example";
    try {
      const run = await startRun(ctx, {
        flowVersionId: f.flowVersionId,
        triggeredBy: USER,
        runInput: {},
      });
      expect(await waitForRunStatus(run, ["failed"])).toBe("failed");
      const delivery = await waitForDelivery(
        (d) => d.parsed.event === "run.failed" && d.parsed.runId === run,
      );
      const reason = String(delivery.parsed.data.reason);
      expect(reason).not.toContain("leak@private.test");
      expect(reason).not.toContain("4012888888881881");
      expect(reason).toContain("[REDACTED:number]");
    } finally {
      delete process.env.MAKERCHECKER_REDACTION;
    }
  });

  it("never calls disabled endpoints", () => {
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.path !== "/disabled")).toBe(true);
  });
});
