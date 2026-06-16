import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { isApprovalGate, SCHEMA_VERSION, type FlowDefinition } from "@makerchecker/shared";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";

import { actorOf, authDisabled, registerAdminRoutes, requireAdmin } from "./api/admin-routes.js";
import { registerProxyRoutes } from "./api/proxy-routes.js";
import { authenticateApiKey, type AuthUser } from "./auth/api-keys.js";
import { verifyChain } from "./audit/verify.js";
import {
  ApprovalDecisionError,
  decideApproval,
  startRun,
  type EngineContext,
} from "./engine/orchestrator.js";
import { overdueThresholdMinutes } from "./engine/watchdog.js";
import { redactValue, resolveRedactionHook } from "./llm/redaction.js";
import { renderMetrics } from "./metrics.js";
import { getAccessReview } from "./reports/access-review.js";
import { registerWebStatic, resolveWebDist } from "./web-static.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

// Top-level body schemas for the two run/approval routes whose Body was typed in
// TypeScript but not validated at runtime. additionalProperties:false rejects an
// unexpected key (mass-assignment / prototype-pollution) before the handler runs.

// The skill `input` VALUE is deliberately free-form (arbitrary per-flow JSON), so
// only the wrapping object is constrained, never input's contents. The body is a
// union with null so a payload-less POST (req.body === null, flow input defaults
// apply) still validates; an object body is locked to {input?} only.
const TriggerRunBody = Type.Union([
  Type.Object(
    { input: Type.Optional(Type.Record(Type.String(), Type.Unknown())) },
    { additionalProperties: false },
  ),
  Type.Null(),
]);

// `decision` stays a plain string here so the handler keeps emitting its
// domain-specific 400 ('decision must be "approved" or "rejected"') for a bad
// value; the schema's job is solely to lock the surrounding shape.
const DecisionBody = Type.Object(
  {
    decision: Type.String(),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// Route :id params are UUIDs. Validating the format up front turns a malformed
// id into a clean 400 instead of letting it reach a uuid-typed query and throw
// a raw Postgres 22P02 (500). Matches the admin/proxy routes' IdParams.
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const IdParams = Type.Object({ id: Type.String({ pattern: UUID_PATTERN }) });

/**
 * The MakerChecker API: run/approval endpoints plus admin CRUD (see
 * api/admin-routes.ts). All API routes live under the /api prefix so they
 * never collide with SPA routes (the UI's /runs/:id must full-page-load the
 * app, not JSON). Every /api route requires an API key (`authorization:
 * Bearer mk_...`) unless MAKERCHECKER_AUTH_DISABLED=1 (compose demo mode);
 * /healthz and static web assets stay open. The OpenAPI document is served
 * at /api/openapi.json.
 */
export async function buildApp(ctx?: EngineContext): Promise<FastifyInstance> {
  // removeAdditional:false makes body schemas REJECT (400) an unknown property
  // instead of silently stripping it (the @fastify/ajv-compiler default is
  // removeAdditional:true). Combined with additionalProperties:false on every
  // body schema, an unexpected top-level key (a mass-assignment or
  // prototype-pollution attempt) is now an explicit 400, not a quiet drop.
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Global error handler. Deliberate domain responses (reply.status(4xx).send)
  // never reach here. For an UNCAUGHT/re-thrown error: pass <500 through (this
  // preserves Fastify's FST_ERR_VALIDATION 400 messages), but for >=500 log the
  // full error server-side and return a generic body so infrastructure details
  // (DB host:port, pg driver codes, stack traces) are never disclosed to a caller.
  app.setErrorHandler((err, req, reply) => {
    const status =
      (err as { statusCode?: number }).statusCode ?? (err as { status?: number }).status ?? 500;
    if (status < 500) return reply.status(status).send(err);
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal error" });
  });

  // Security middleware, registered BEFORE any route so it covers /healthz,
  // the served SPA, and every /api endpoint.

  // helmet: a Content-Security-Policy tuned for the bundled React SPA. The Vite
  // build emits self-hosted JS/CSS and inline <style> tags; data: URIs cover
  // inlined font/image assets. No remote origins are allowed, so a script
  // injected into a stored field cannot exfiltrate to a third party.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "script-src": ["'self'"],
        "img-src": ["'self'", "data:"],
      },
    },
  });

  // cors: locked down by default (no Access-Control-Allow-Origin emitted, so
  // browsers block cross-origin reads). An operator opts specific origins in via
  // ALLOWED_ORIGINS (comma-separated). Credentials stay off: the API is bearer
  // -token authenticated, not cookie-based, so it never needs credentialed CORS.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  await app.register(cors, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    credentials: false,
  });

  // rate-limit: 100 requests/minute per IP, with /healthz and /metrics exempt
  // (liveness probes and Prometheus scrapers must never be throttled). Disabled
  // under test (NODE_ENV=test, set automatically by vitest) and via the
  // MAKERCHECKER_DISABLE_RATE_LIMIT=1 escape hatch, so the suite's many
  // same-origin app.inject calls never trip a 429.
  //
  // global:false + a root-level onRequest hook (not the plugin's per-route
  // attachment) so the limiter runs BEFORE the /api auth hook. Otherwise an
  // unauthenticated flood of /api/* would short-circuit at the 401 and never be
  // counted, leaving the API open to credential-less request floods.
  if (
    process.env.NODE_ENV !== "test" &&
    process.env.MAKERCHECKER_DISABLE_RATE_LIMIT !== "1"
  ) {
    await app.register(rateLimit, {
      global: false,
      max: 100,
      timeWindow: "1 minute",
      allowList: (req) => {
        const path = (req.url ?? "").split("?")[0];
        return path === "/healthz" || path === "/metrics";
      },
    });
    app.addHook("onRequest", app.rateLimit());
  }

  app.get(
    "/healthz",
    { schema: { operationId: "health", tags: ["meta"] } },
    async () => ({
      status: "ok",
      schemaVersion: SCHEMA_VERSION,
    }),
  );

  // Serve the built SPA when present (single-container deploys). Registered
  // before the auth hook so static assets never require an API key.
  const webDist = resolveWebDist();
  if (webDist) await registerWebStatic(app, webDist);

  if (!ctx) return app;

  // Prometheus exposition at the root (outside /api, no auth) — scrapers live
  // inside the deployment perimeter, so exposing it is an explicit operator
  // opt-in via MAKERCHECKER_METRICS=1 at boot.
  if (process.env.MAKERCHECKER_METRICS === "1") {
    app.get("/metrics", async (_req, reply) => {
      const text = await renderMetrics(ctx.pool);
      return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(text);
    });
  }

  // Awaited so the swagger onRoute hook is installed before routes register.
  // Registered at root, BEFORE the /api-prefixed scope below, so the route
  // prefix shows up in the document paths automatically.
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "MakerChecker API",
        description: "Governance + orchestration control plane for enterprise AI agents.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          apiKey: { type: "http", scheme: "bearer", description: "API key (mk_...)" },
        },
      },
      security: [{ apiKey: [] }],
    },
  });

  app.decorateRequest("authUser", null);

  // Everything below is encapsulated under /api: the auth hook applies to
  // /api/* only (/healthz and static assets stay open), and every API route
  // — run/approval/audit here plus the admin CRUD — picks up the prefix.
  await app.register(registerApiRoutes, { prefix: "/api", ctx });

  return app;
}

async function registerApiRoutes(
  api: FastifyInstance,
  { ctx }: { ctx: EngineContext },
): Promise<void> {
  api.addHook("onRequest", async (req, reply) => {
    if (process.env.MAKERCHECKER_AUTH_DISABLED === "1") return; // compose demo mode
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "missing API key (authorization: Bearer mk_...)" });
    }
    const user = await authenticateApiKey(ctx.pool, header.slice("Bearer ".length));
    if (!user) {
      return reply.status(401).send({ error: "invalid or revoked API key" });
    }
    req.authUser = user;
  });

  api.get(
    "/openapi.json",
    { schema: { operationId: "getOpenapiDocument", tags: ["meta"] } },
    async () => api.swagger(),
  );

  registerAdminRoutes(api, ctx);
  registerProxyRoutes(api, ctx);

  api.post<{ Params: { name: string }; Body: { input?: Record<string, unknown> } | null }>(
    "/flows/:name/runs",
    {
      schema: {
        operationId: "triggerFlowRun",
        tags: ["runs"],
        // Lock the TOP-LEVEL body shape (additionalProperties:false blocks
        // mass-assignment / prototype-pollution via an unexpected key) while
        // leaving the skill `input` VALUE free-form: it is forwarded verbatim
        // to the flow and is legitimately arbitrary per-flow JSON.
        body: TriggerRunBody,
      },
    },
    async (req, reply) => {
      const { rows } = await ctx.pool.query<{ id: string }>(
        `SELECT fv.id FROM flow_versions fv
           JOIN flows f ON f.id = fv.flow_id
          WHERE f.name = $1 AND fv.status = 'published'
          ORDER BY fv.version DESC LIMIT 1`,
        [req.params.name],
      );
      if (!rows[0]) {
        return reply.status(404).send({ error: `no published flow named "${req.params.name}"` });
      }
      const runId = await startRun(ctx, {
        flowVersionId: rows[0].id,
        triggeredBy: actorOf(req),
        runInput: req.body?.input ?? {},
      });
      return reply.status(201).send({ runId });
    },
  );

  api.get(
    "/runs",
    { schema: { operationId: "listRuns", tags: ["runs"] } },
    async (req) => {
      // Object-level read scope: a non-admin sees only runs they are party to
      // (triggered, decided on, or are a named approver for) — the same
      // predicate canReadRun applies to the detail endpoint. Admins and
      // auth-disabled mode see every run.
      const privileged = isPrivileged(req);
      const user = req.authUser;
      const { rows } = await ctx.pool.query(
        `SELECT fr.id, f.name AS flow, fv.version, fr.status, fr.failure_reason,
                fr.created_at, fr.started_at, fr.finished_at
           FROM flow_runs fr
           JOIN flow_versions fv ON fv.id = fr.flow_version_id
           JOIN flows f ON f.id = fv.flow_id
          WHERE (
            $1
            OR (fr.triggered_by->>'type' = 'user' AND fr.triggered_by->>'id' = $2)
            OR EXISTS (
              SELECT 1 FROM approvals ap
                JOIN approval_decisions ad ON ad.approval_id = ap.id
               WHERE ap.run_id = fr.id AND ad.decided_by_user_id::text = $2)
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements(fv.definition->'steps') AS step
                CROSS JOIN LATERAL jsonb_array_elements_text(
                  COALESCE(step->'approvals'->'approver_emails', '[]'::jsonb)) AS approver_email
               WHERE approver_email = $3)
          )
          ORDER BY fr.created_at DESC LIMIT 50`,
        [privileged, user?.id ?? null, user?.email ?? null],
      );
      // failure_reason embeds the raw step error (skill-influenced); redact it.
      const redact = resolveRedactionHook();
      const runs = rows.map((r: Record<string, unknown>) => ({
        ...r,
        failure_reason: redactValue(redact, r.failure_reason),
      }));
      return { runs };
    },
  );

  api.get<{ Params: { id: string } }>(
    "/runs/:id",
    { schema: { operationId: "getRun", tags: ["runs"], params: IdParams } },
    async (req, reply) => {
      // Object-level read scope: a non-admin must not learn about another
      // actor's run. Deny before any row is fetched, with the same 404 a
      // missing run returns, so existence does not leak.
      if (!(await canReadRun(ctx.pool, req, req.params.id))) {
        return reply.status(404).send({ error: "run not found" });
      }
      const run = await ctx.pool.query(
        `SELECT fr.id, f.name AS flow, fv.version, fv.definition, fr.status,
                fr.failure_reason, fr.input, fr.triggered_by,
                fr.created_at, fr.started_at, fr.finished_at
           FROM flow_runs fr
           JOIN flow_versions fv ON fv.id = fr.flow_version_id
           JOIN flows f ON f.id = fv.flow_id
          WHERE fr.id = $1`,
        [req.params.id],
      );
      if (!run.rows[0]) return reply.status(404).send({ error: "run not found" });

      const steps = await ctx.pool.query(
        `SELECT sr.id, sr.step_index, sr.step_key, sr.status, sr.attempt,
                sr.input, sr.output, sr.error, a.name AS agent,
                sr.started_at, sr.finished_at
           FROM step_runs sr LEFT JOIN agents a ON a.id = sr.agent_id
          WHERE sr.run_id = $1 ORDER BY sr.step_index, sr.attempt`,
        [req.params.id],
      );
      const approvals = await ctx.pool.query<{ id: string }>(
        `SELECT ap.id, ap.step_key, ap.status, ap.requested_at, ap.decided_at,
                ap.reason, ap.required_approvals, u.email AS decided_by
           FROM approvals ap LEFT JOIN users u ON u.id = ap.decided_by_user_id
          WHERE ap.run_id = $1 ORDER BY ap.requested_at`,
        [req.params.id],
      );
      const decisions = await ctx.pool.query<{ approval_id: string }>(
        `SELECT ad.id, ad.approval_id, ad.decision, ad.reason, ad.created_at,
                coalesce(u.email, ad.decided_by_label) AS decided_by
           FROM approval_decisions ad
           JOIN approvals ap ON ap.id = ad.approval_id
           LEFT JOIN users u ON u.id = ad.decided_by_user_id
          WHERE ap.run_id = $1 ORDER BY ad.created_at, ad.id`,
        [req.params.id],
      );
      const decisionsByApproval = new Map<string, Record<string, unknown>[]>();
      for (const { approval_id, ...decision } of decisions.rows) {
        const list = decisionsByApproval.get(approval_id) ?? [];
        list.push(decision);
        decisionsByApproval.set(approval_id, list);
      }
      const events = await ctx.pool.query<{ payload: Record<string, unknown> }>(
        `SELECT seq, occurred_at, actor, event_type, payload, hash
           FROM audit_events WHERE run_id = $1 ORDER BY seq`,
        [req.params.id],
      );
      // Read-path redaction: the configured hook (MAKERCHECKER_REDACTION)
      // masks the run input, failure reason, step I/O, and audit payloads in the
      // response. At-rest rows stay raw — the hook governs exposure, not storage.
      // (failure_reason embeds the raw step error, which can carry skill PII.)
      const redact = resolveRedactionHook();
      const runRow = run.rows[0] as Record<string, unknown>;
      return {
        run: {
          ...runRow,
          input: redactValue(redact, runRow.input),
          failure_reason: redactValue(redact, runRow.failure_reason),
        },
        steps: steps.rows.map((s: Record<string, unknown>) => ({
          ...s,
          input: redactValue(redact, s.input),
          output: redactValue(redact, s.output),
          error: redactValue(redact, s.error),
        })),
        approvals: approvals.rows.map((ap) => ({
          ...ap,
          decisions: decisionsByApproval.get(ap.id) ?? [],
        })),
        auditEvents: events.rows.map((e) => ({ ...e, payload: redact(e.payload) })),
      };
    },
  );

  api.get(
    "/approvals",
    { schema: { operationId: "listPendingApprovals", tags: ["approvals"] } },
    async (req) => {
      // Object-level scope: admins (and auth-disabled mode) see the whole
      // pending inbox; a non-admin sees only approvals they could legitimately
      // act on — runs they triggered, approvals they have already decided, or
      // gates whose approver pool includes them. A gate with a named
      // `approver_emails` list is visible only to those named members; a gate
      // WITHOUT a list has an open approver pool (the orchestrator accepts any
      // authenticated non-requester), so it stays visible to every non-admin.
      // Deny by default for anything else.
      const privileged = isPrivileged(req);
      const user = req.authUser;
      const { rows } = await ctx.pool.query(
        `SELECT ap.id, ap.run_id, ap.step_key, ap.requested_at, ap.required_approvals,
                (SELECT count(*)::int FROM approval_decisions ad
                  WHERE ad.approval_id = ap.id AND ad.decision = 'approved') AS approved_count,
                extract(epoch FROM (now() - ap.requested_at))::int AS age_seconds,
                (ap.requested_at < now() - make_interval(mins => $1)) AS overdue,
                f.name AS flow
           FROM approvals ap
           JOIN flow_runs fr ON fr.id = ap.run_id
           JOIN flow_versions fv ON fv.id = fr.flow_version_id
           JOIN flows f ON f.id = fv.flow_id
          WHERE ap.status = 'pending'
            AND (
              $2::boolean
              OR (fr.triggered_by->>'type' = 'user' AND fr.triggered_by->>'id' = $3)
              OR EXISTS (
                SELECT 1 FROM approval_decisions ad
                 WHERE ad.approval_id = ap.id AND ad.decided_by_user_id::text = $3)
              OR EXISTS (
                -- The gate at this approval's step. An IDENTITY-MODE gate (has an
                -- approvals object) is visible if it names no approver list
                -- (open pool, decidable by any non-requester) or names this user.
                -- A LEGACY gate (no approvals object) is ungoverned and only
                -- decidable by a run participant, so it must NOT show here on the
                -- open-pool branch -- it surfaces only via the triggered/decided
                -- checks above. This matches authorizeDecision's split exactly.
                SELECT 1
                  FROM jsonb_array_elements(fv.definition->'steps')
                       WITH ORDINALITY AS s(step, ord)
                 WHERE s.ord - 1 = ap.step_index
                   AND s.step->'approvals' IS NOT NULL
                   AND (
                     s.step->'approvals'->'approver_emails' IS NULL
                     OR s.step->'approvals'->'approver_emails' @> to_jsonb($4::text)
                   ))
            )
          ORDER BY ap.requested_at`,
        [overdueThresholdMinutes(), privileged, user?.id ?? null, user?.email ?? null],
      );
      return { approvals: rows };
    },
  );

  api.post<{
    Params: { id: string };
    Body: { decision: "approved" | "rejected"; reason?: string };
  }>(
    "/approvals/:id/decision",
    {
      schema: {
        operationId: "decideApproval",
        tags: ["approvals"],
        params: IdParams,
        // additionalProperties:false locks the body to {decision, reason?} so a
        // decider cannot smuggle extra fields into the handler. The handler's
        // own check (below) still rejects an unknown decision value with a
        // domain-specific message; the schema enforces the surrounding shape.
        body: DecisionBody,
      },
    },
    async (req, reply) => {
      const decision = req.body?.decision;
      if (decision !== "approved" && decision !== "rejected") {
        return reply.status(400).send({ error: 'decision must be "approved" or "rejected"' });
      }
      // Identity-mode gates defer to the orchestrator (which audits its own
      // denials); legacy/ungoverned gates require the decider be party to the
      // run. See authorizeDecision.
      const denied = await authorizeDecision(ctx.pool, req, req.params.id);
      if (denied) return reply.status(403).send({ error: denied });
      try {
        await decideApproval(ctx, {
          approvalId: req.params.id,
          decision,
          decidedBy: actorOf(req),
          ...(req.authUser ? { userId: req.authUser.id, userEmail: req.authUser.email } : {}),
          ...(req.body?.reason !== undefined ? { reason: req.body.reason } : {}),
        });
      } catch (err) {
        if (err instanceof ApprovalDecisionError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        const message = (err as Error).message;
        const status = /not found/.test(message) ? 404 : /already/.test(message) ? 409 : 500;
        return reply.status(status).send({ error: message });
      }
      return { ok: true };
    },
  );

  api.get(
    "/audit/verify",
    { schema: { operationId: "verifyAuditChain", tags: ["audit"] } },
    // Chain-integrity status (ok / head hash / event count) is intentionally
    // readable by any authenticated key: it is the org-wide trust signal the
    // Run viewer's ChainBadge renders for every user. It exposes no event
    // payloads or per-run data — only the public chain anchor.
    async () => verifyChain(ctx.pool),
  );

  api.get(
    "/reports/access-review",
    {
      schema: { operationId: "getAccessReview", tags: ["reports"] },
      // Exposes the full RBAC/SoD posture and administrator emails.
      preHandler: [requireAdmin],
    },
    async () => getAccessReview(ctx.pool),
  );
}

// --- authorization helpers (deny by default; see TASK D) ---

/**
 * True when the request is privileged enough to read/decide across actors:
 * either auth is disabled (operator opt-out) or the key belongs to an admin.
 * Non-admins are scoped to their own data.
 */
function isPrivileged(req: { authUser: AuthUser | null }): boolean {
  return authDisabled() || req.authUser?.is_admin === true;
}

/**
 * Object-level read scope for a single run. An admin (or auth-disabled mode)
 * sees any run. A non-admin may read a run only if they are associated with
 * it: they triggered it, they are a named approver on one of its gates, or
 * they have already recorded a decision on it. Anything else is denied — we
 * prefer a 404 (indistinguishable from "no such run") over leaking a run's
 * existence to an unrelated actor.
 *
 * Note: agents are not owned by a user in the schema, so a run triggered by an
 * agent has no resolvable user owner; such runs are visible only to admins.
 */
async function canReadRun(
  pool: EngineContext["pool"],
  req: { authUser: AuthUser | null },
  runId: string,
): Promise<boolean> {
  if (isPrivileged(req)) return true;
  const user = req.authUser;
  if (!user) return false; // auth on but no user: fail closed
  // $2 (the user id) is passed as text and compared against text on both sides
  // (->>'id' is text; decided_by_user_id is cast to text) so Postgres never has
  // to reconcile a uuid = text comparison.
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM flow_runs fr
        WHERE fr.id = $1
          AND (
            (fr.triggered_by->>'type' = 'user' AND fr.triggered_by->>'id' = $2)
            OR EXISTS (
              SELECT 1 FROM approvals ap
                JOIN approval_decisions ad ON ad.approval_id = ap.id
               WHERE ap.run_id = fr.id AND ad.decided_by_user_id::text = $2)
            OR EXISTS (
              SELECT 1
                FROM flow_versions fv
                CROSS JOIN LATERAL jsonb_array_elements(fv.definition->'steps') AS step
                CROSS JOIN LATERAL jsonb_array_elements_text(
                  COALESCE(step->'approvals'->'approver_emails', '[]'::jsonb)) AS approver_email
               WHERE fv.id = fr.flow_version_id AND approver_email = $3)
          )
     ) AS ok`,
    [runId, user.id, user.email],
  );
  return rows[0]?.ok === true;
}

/**
 * Authorizes an approval decision at the API edge.
 *
 * For any gate that defines an `approvals` object (identity-mode), this layer
 * DEFERS entirely to the orchestrator, which both enforces AND audits the
 * per-gate identity rules (named-list membership, forbid_requester, quorum, the
 * authenticated-decision requirement) via an immutable `approval.decision_denied`
 * event. Re-implementing those rules here would emit a SILENT 403 that escapes
 * the audit chain and would get the open-pool semantic wrong (a forbid_requester
 * gate with no approver list is meant to be cleared by ANY non-requester, who
 * need not otherwise be party to the run).
 *
 * A LEGACY gate (no `approvals` object) is ungoverned: the orchestrator applies
 * no n-of-m identity rule to it. We do not let that mean "any authenticated key
 * may clear anyone's gate" — the decider must still be PARTY to the run (the
 * same object scope as `canReadRun`: they triggered it, are a named approver, or
 * already decided on it). The run's own requester therefore may decide an
 * ungoverned gate (no self-approval rule applies without an `approvals` object),
 * but an unrelated key cannot. Returns a 403 message, or null to proceed.
 */
async function authorizeDecision(
  pool: EngineContext["pool"],
  req: { authUser: AuthUser | null },
  approvalId: string,
): Promise<string | null> {
  if (authDisabled()) return null; // operator opt-out
  const user = req.authUser;
  if (!user) return "this decision requires an authenticated key"; // auth on, no user
  if (user.is_admin === true) return null; // admins may decide any gate

  const { rows } = await pool.query<{
    definition: FlowDefinition;
    step_index: number;
    run_id: string;
  }>(
    `SELECT fv.definition, ap.step_index, ap.run_id
       FROM approvals ap
       JOIN flow_runs fr ON fr.id = ap.run_id
       JOIN flow_versions fv ON fv.id = fr.flow_version_id
      WHERE ap.id = $1`,
    [approvalId],
  );
  // Unknown approval: defer to the orchestrator, which raises the 404.
  if (!rows[0]) return null;

  const step = rows[0].definition.steps[rows[0].step_index];
  const gateApprovals = step && isApprovalGate(step) ? step.approvals : undefined;

  // Identity-mode gate: the orchestrator governs AND audits the decision.
  if (gateApprovals) return null;

  // Legacy/ungoverned gate: no identity rule, but the decider must be party to
  // the run so an unrelated key cannot clear another actor's gate.
  if (await canReadRun(pool, req, rows[0].run_id)) return null;
  return "you are not authorized to decide this approval";
}
