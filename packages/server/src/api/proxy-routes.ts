import { SKILL_REF_PATTERN } from "@makerchecker/shared";
import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { EngineContext } from "../engine/orchestrator.js";
import { redactValue, resolveRedactionHook } from "../llm/redaction.js";
import {
  checkAndAuthorize,
  closeSession,
  openSession,
  recordResult,
  ProxyError,
} from "../proxy/service.js";
import { actorOf, authDisabled } from "./admin-routes.js";

/**
 * Proxy session routes: the governance checkpoint for externally-orchestrated
 * agents. The caller's framework executes the tools; these endpoints decide
 * whether each call is authorized and append the evidentiary record. A denial
 * is a decision, not an error: /check returns 200 with {allowed: false} so
 * SDK wrappers can branch without exception plumbing. Session-level problems
 * (unknown id, closed session, denied check) map to 404/409.
 */

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_PATTERN }) });
type IdParamsT = Static<typeof IdParams>;

const JsonObject = Type.Record(Type.String(), Type.Unknown());

const OpenSessionBody = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    externalRef: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CheckBody = Type.Object(
  {
    agentName: Type.String({ minLength: 1 }),
    skillRef: Type.String({ pattern: SKILL_REF_PATTERN }),
    input: Type.Optional(JsonObject),
  },
  { additionalProperties: false },
);

const RecordResultBody = Type.Object(
  {
    checkId: Type.String({ pattern: UUID_PATTERN }),
    output: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

function sendProxyError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ProxyError) {
    return reply.status(err.statusCode).send({ error: err.message });
  }
  throw err;
}

/**
 * Object-level access scope for a proxy session: an admin (or auth-disabled
 * mode) may act on any session; a non-admin only on one they created. A missing
 * session also returns false so the caller answers with the same 404 and never
 * leaks existence. Applied to the mutating routes (check/record/close) as well
 * as reads, so a non-owner cannot close, probe, or pollute another actor's
 * governance session by guessing its id.
 */
async function canAccessSession(
  pool: EngineContext["pool"],
  req: { authUser: { id: string; is_admin?: boolean } | null },
  sessionId: string,
): Promise<boolean> {
  if (authDisabled() || req.authUser?.is_admin === true) return true;
  if (!req.authUser) return false;
  const { rows } = await pool.query<{ created_by_user_id: string | null }>(
    "SELECT created_by_user_id FROM proxy_sessions WHERE id = $1",
    [sessionId],
  );
  if (!rows[0]) return false;
  return rows[0].created_by_user_id === req.authUser.id;
}

export function registerProxyRoutes(app: FastifyInstance, ctx: EngineContext): void {
  const { pool } = ctx;

  app.post<{ Body: Static<typeof OpenSessionBody> }>(
    "/proxy/sessions",
    { schema: { operationId: "openProxySession", tags: ["proxy"], body: OpenSessionBody } },
    async (req, reply) => {
      const session = await openSession(pool, {
        label: req.body.label,
        actor: actorOf(req),
        ...(req.body.externalRef !== undefined ? { externalRef: req.body.externalRef } : {}),
        ...(req.authUser ? { userId: req.authUser.id } : {}),
      });
      return reply.status(201).send({ session });
    },
  );

  app.post<{ Params: IdParamsT; Body: Static<typeof CheckBody> }>(
    "/proxy/sessions/:id/check",
    {
      schema: {
        operationId: "checkProxyAction",
        tags: ["proxy"],
        params: IdParams,
        body: CheckBody,
      },
    },
    async (req, reply) => {
      if (!(await canAccessSession(pool, req, req.params.id))) {
        return reply.status(404).send({ error: "proxy session not found" });
      }
      try {
        return await checkAndAuthorize(pool, {
          sessionId: req.params.id,
          agentName: req.body.agentName,
          skillRef: req.body.skillRef,
          actor: actorOf(req),
          ...(req.body.input !== undefined ? { input: req.body.input } : {}),
        });
      } catch (err) {
        return sendProxyError(reply, err);
      }
    },
  );

  app.post<{ Params: IdParamsT; Body: Static<typeof RecordResultBody> }>(
    "/proxy/sessions/:id/record",
    {
      schema: {
        operationId: "recordProxyResult",
        tags: ["proxy"],
        params: IdParams,
        body: RecordResultBody,
      },
    },
    async (req, reply) => {
      if (!(await canAccessSession(pool, req, req.params.id))) {
        return reply.status(404).send({ error: "proxy session not found" });
      }
      try {
        await recordResult(pool, {
          sessionId: req.params.id,
          checkId: req.body.checkId,
          actor: actorOf(req),
          ...(req.body.output !== undefined ? { output: req.body.output } : {}),
          ...(req.body.error !== undefined ? { error: req.body.error } : {}),
        });
        return { ok: true };
      } catch (err) {
        return sendProxyError(reply, err);
      }
    },
  );

  app.post<{ Params: IdParamsT }>(
    "/proxy/sessions/:id/close",
    { schema: { operationId: "closeProxySession", tags: ["proxy"], params: IdParams } },
    async (req, reply) => {
      if (!(await canAccessSession(pool, req, req.params.id))) {
        return reply.status(404).send({ error: "proxy session not found" });
      }
      try {
        const session = await closeSession(pool, {
          sessionId: req.params.id,
          actor: actorOf(req),
        });
        return { session };
      } catch (err) {
        return sendProxyError(reply, err);
      }
    },
  );

  app.get<{ Params: IdParamsT }>(
    "/proxy/sessions/:id",
    { schema: { operationId: "getProxySession", tags: ["proxy"], params: IdParams } },
    async (req, reply) => {
      const session = await pool.query(
        `SELECT id, label, external_ref, status, created_by_user_id, created_at, closed_at
           FROM proxy_sessions WHERE id = $1`,
        [req.params.id],
      );
      if (!session.rows[0]) return reply.status(404).send({ error: "proxy session not found" });
      // Object-level read scope: an admin (or auth-disabled mode) reads any
      // session; a non-admin reads only sessions they created. Return the same
      // 404 a missing session would, so existence does not leak.
      const privileged = authDisabled() || req.authUser?.is_admin === true;
      if (!privileged) {
        const owner = session.rows[0].created_by_user_id as string | null;
        if (!req.authUser || owner !== req.authUser.id) {
          return reply.status(404).send({ error: "proxy session not found" });
        }
      }
      const actions = await pool.query(
        `SELECT pa.id, pa.agent_id, a.name AS agent, pa.role_id_snapshot, pa.skill_id,
                pa.skill_ref, pa.decision, pa.created_at
           FROM proxy_actions pa
           JOIN agents a ON a.id = pa.agent_id
          WHERE pa.session_id = $1 ORDER BY pa.created_at, pa.id`,
        [req.params.id],
      );
      // Same correlation pattern as run events (run_id): every event of a
      // session is stamped entity_type 'proxy_session' + entity_id.
      const events = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT seq, occurred_at, actor, event_type, payload, hash
           FROM audit_events
          WHERE entity_type = 'proxy_session' AND entity_id = $1 ORDER BY seq`,
        [req.params.id],
      );
      // Read-path redaction, mirroring GET /api/runs/:id: mask audit payloads
      // AND the caller-supplied session columns (label/external_ref) so this view
      // never exposes more than the redacted audit copy of the same data.
      const redact = resolveRedactionHook();
      const auditEvents = events.rows.map((e) => ({ ...e, payload: redact(e.payload) }));
      const sessionRow = session.rows[0] as Record<string, unknown>;
      const maskedSession = {
        ...sessionRow,
        label: redactValue(redact, sessionRow.label),
        external_ref: redactValue(redact, sessionRow.external_ref),
      };
      // actions carry caller-supplied free text too: skill_ref is stored verbatim
      // from the request (a denied check preserves what was asked for), and agent
      // is registry-controlled but masked for parity with the audit copy.
      const maskedActions = actions.rows.map((a) => ({
        ...a,
        skill_ref: redactValue(redact, a.skill_ref),
        agent: redactValue(redact, a.agent),
      }));
      return { session: maskedSession, actions: maskedActions, auditEvents };
    },
  );
}
