/**
 * Shared capture for the marketing "live demo" fixtures.
 *
 * Both the MDR and AML demos replay a real gated flow through the real product
 * components. This captures one such flow end-to-end against real Postgres with
 * auth ENABLED, so the maker-checker block is the product's actual
 * `forbid_requester` rejection — never a mock. Used by the per-flow drift-guard
 * tests (src/demo/*-fixtures.test.ts), which re-capture on every CI run.
 *
 * Lives under test/ (like test-db.ts) so it is test-support, excluded from
 * coverage, and may import vitest's inject transitively.
 */
import { generateApiKey } from "../src/auth/api-keys.js";
import { buildApp } from "../src/app.js";
import { GraphileWorkerBackend } from "../src/engine/graphile-backend.js";
import { createHandlers, type EngineContext } from "../src/engine/orchestrator.js";
import { SkillInvoker } from "../src/skills/invoker.js";
import { SequentialInvokerExecutor } from "../src/skills/sequential-executor.js";
import { demoLocalRegistry } from "../src/demo/skills.js";
import { seedDemo } from "../src/demo/seed.js";
import { createTestDb } from "./test-db.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeJson(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface CaptureOpts {
  /** Flow to run, e.g. "mdr-reportability-triage". */
  flowName: string;
  /** Trigger input payload, e.g. { complaintsPath } or { alertsPath }. */
  input: Record<string, unknown>;
  /** The maker/requester identity (triggers the run, then is blocked from approving). */
  requesterEmail: string;
  /** The checker identity (approves the gate). */
  officerEmail: string;
  /** The reason the officer records on approval. */
  officerReason: string;
}

/**
 * Capture a complete gated flow as the demo replays it: scene snapshots plus
 * the real maker-checker block. Self-contained — creates and drops its own DB.
 */
export async function captureGatedFlow(opts: CaptureOpts): Promise<Record<string, unknown>> {
  // The block is only real with auth on; never let a sibling test's
  // compose-mode flag bleed in.
  delete process.env.MAKERCHECKER_AUTH_DISABLED;
  const db = await createTestDb();
  let backend: GraphileWorkerBackend | undefined;
  try {
    await seedDemo(db.pool);
    backend = new GraphileWorkerBackend(db.pool, 5);
    const invoker = new SkillInvoker(db.pool, demoLocalRegistry());
    const ctx: EngineContext = {
      pool: db.pool,
      backend,
      executor: new SequentialInvokerExecutor(invoker, db.pool),
    };
    await backend.start(createHandlers(ctx));
    const app = await buildApp(ctx);

    try {
      const people = await db.pool.query<{ id: string; email: string; display_name: string }>(
        "SELECT id, email, display_name FROM users WHERE email IN ($1, $2)",
        [opts.requesterEmail, opts.officerEmail],
      );
      const analyst = people.rows.find((u) => u.email === opts.requesterEmail)!;
      const officer = people.rows.find((u) => u.email === opts.officerEmail)!;
      const analystKey = (await generateApiKey(db.pool, { userId: analyst.id, name: "demo-capture" })).plaintext;
      const officerKey = (await generateApiKey(db.pool, { userId: officer.id, name: "demo-capture" })).plaintext;
      const auth = (key: string) => ({ authorization: `Bearer ${key}` });

      const trig = await app.inject({
        method: "POST",
        url: `/api/flows/${opts.flowName}/runs`,
        headers: auth(analystKey),
        payload: { input: opts.input },
      });
      if (trig.statusCode !== 201) throw new Error(`trigger failed: ${trig.statusCode} ${trig.body}`);
      const runId = trig.json().runId as string;

      // Opportunistic "in progress" snapshot for a live-feeling open.
      let running: unknown = null;
      for (let i = 0; i < 100; i++) {
        const d = (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: auth(analystKey) })).json();
        const s = d.run.status as string;
        if (s === "waiting_approval" || s === "completed" || s === "failed") {
          if (!running) running = d;
          break;
        }
        running = d;
        await sleep(12);
      }

      for (let i = 0; i < 400; i++) {
        const { rows } = await db.pool.query<{ status: string }>("SELECT status FROM flow_runs WHERE id=$1", [runId]);
        if (["waiting_approval", "completed", "failed"].includes(rows[0]!.status)) break;
        await sleep(50);
      }
      const waiting = (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: auth(analystKey) })).json();
      const approvalsWaiting = (await app.inject({ method: "GET", url: "/api/approvals", headers: auth(analystKey) })).json();
      const pending = approvalsWaiting.approvals.find((a: { run_id: string }) => a.run_id === runId);
      const approvalId = pending.id as string;

      // The maker-checker block: the requester tries to approve their own run.
      const blockedRes = await app.inject({
        method: "POST",
        url: `/api/approvals/${approvalId}/decision`,
        headers: auth(analystKey),
        payload: { decision: "approved", reason: "(self-approval attempt)" },
      });
      const blockedBody = safeJson(blockedRes.body);
      const blockedDecision = {
        status: blockedRes.statusCode,
        message: (blockedBody?.message as string) ?? (blockedBody?.error as string) ?? blockedRes.body,
      };

      // The officer (the checker) approves.
      const okRes = await app.inject({
        method: "POST",
        url: `/api/approvals/${approvalId}/decision`,
        headers: auth(officerKey),
        payload: { decision: "approved", reason: opts.officerReason },
      });
      const approvedDecision = { status: okRes.statusCode };

      for (let i = 0; i < 600; i++) {
        const { rows } = await db.pool.query<{ status: string }>("SELECT status FROM flow_runs WHERE id=$1", [runId]);
        if (["completed", "failed"].includes(rows[0]!.status)) break;
        await sleep(50);
      }
      const completed = (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: auth(officerKey) })).json();
      const verify = (await app.inject({ method: "GET", url: "/api/audit/verify", headers: auth(officerKey) })).json();
      const runsList = (await app.inject({ method: "GET", url: "/api/runs", headers: auth(officerKey) })).json();

      const bundle = {
        meta: {
          flow: opts.flowName,
          note: "Captured from a real seeded run (auth enabled). Do not hand-edit; regenerate with CAPTURE_WRITE=1.",
        },
        actors: {
          analyst: { name: analyst.display_name, email: analyst.email },
          officer: { name: officer.display_name, email: officer.email },
        },
        scenes: { running, waiting, completed },
        approval: pending,
        blockedDecision,
        approvedDecision,
        verify,
        runsList,
      };

      // Strip the absolute filesystem prefix from any captured data-file path
      // (e.g. the run input). It differs between a dev machine and CI, which
      // would otherwise make the drift guard environment-dependent — and it
      // keeps a local home directory out of the shipped fixture.
      return JSON.parse(JSON.stringify(bundle).replace(/\/[^"]*?\/examples\//g, "examples/"));
    } finally {
      await app.close();
    }
  } finally {
    await backend?.stop();
    await db.drop();
  }
}

/**
 * Replace volatile values (ids, timestamps, hashes, keys) so the captured
 * SHAPE can be compared run-to-run without churn from naturally-changing fields.
 */
export function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.includes("/examples/")) return value.replace(/^.*\/examples\//, "examples/");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "<uuid>";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return "<ts>";
    if (/^[0-9a-f]{64}$/i.test(value)) return "<hash>";
    if (/^mk_[0-9a-f]{32}$/.test(value)) return "<key>";
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

/** Drop the inherently-racy `running` snapshot from a normalised bundle. */
export function withoutRunning(v: unknown): unknown {
  const o = v as { scenes?: Record<string, unknown> } | null;
  if (o && typeof o === "object" && o.scenes) {
    const scenes = { ...o.scenes };
    delete scenes.running;
    return { ...o, scenes };
  }
  return v;
}
