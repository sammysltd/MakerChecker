import type { Pool, PoolClient } from "pg";

import { recordEvent, type Actor } from "../audit/writer.js";
import { checkSodConflict, parseSkillRef } from "../engine/enforcement.js";
import {
  assertQuota,
  assertSkillLimits,
  getRoleLimits,
  LimitViolationError,
  quotaContribution,
  type Quota,
} from "../engine/limits.js";
import { resolveRedactionHook, type RedactionHook } from "../llm/redaction.js";

/**
 * Proxy sessions: governance middleware for agents that live in someone
 * else's framework. The external orchestrator executes the tools; every call
 * is first checked here — same agent/skill/grant/SoD rules as the flow
 * engine, deny by default — and every decision lands in the audit chain in
 * the SAME transaction as its state write.
 *
 * Audit correlation: every event of a session carries entityType
 * 'proxy_session' + entityId = session id (the retrieval key, mirroring how
 * run events use run_id) and repeats the sessionId in its payload.
 *
 * Redaction is part of the write path, mirroring the LLM/sequential
 * executors: the intercepted request input, recorded output, and recorded
 * error are run through the deployment's RedactionHook BEFORE the audit
 * payload is hashed into the chain. The hook governs only what is WRITTEN —
 * never what executes. When no hook is injected it defaults to
 * resolveRedactionHook() so the configured MAKERCHECKER_REDACTION applies
 * without each route having to thread it through.
 */

export type ProxyDenialCode =
  | "agent_not_found"
  | "agent_not_active"
  | "skill_not_found"
  | "skill_deprecated"
  | "skill_not_granted"
  | "high_risk_requires_gate"
  | "sod_violation"
  | "limit_invocations"
  | "limit_amount"
  | "limit_amount_unreadable"
  | "limit_tokens"
  | "limit_run_invocations"
  | "limit_allowlist"
  | "limit_allowlist_unreadable"
  | "limit_path"
  | "limit_path_unreadable"
  | "limit_quota"
  | "limit_quota_unreadable";

export type ProxyCheckResult =
  | { allowed: true; checkId: string }
  | { allowed: false; code: ProxyDenialCode; reason: string };

/** Service-level failure with the HTTP status the API should surface. */
export class ProxyError extends Error {
  override name = "ProxyError";
  constructor(
    readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface ProxySessionRow {
  id: string;
  label: string;
  external_ref: string | null;
  status: "open" | "closed";
  created_by_user_id: string | null;
  created_at: string;
  closed_at: string | null;
}

const SESSION_COLUMNS =
  "id, label, external_ref, status, created_by_user_id, created_at, closed_at";

// Fixed lookup from the validated window enum to a Postgres date_trunc unit.
// The raw window value is NEVER interpolated into SQL: only these literal
// constants reach the query string, so a quota window cannot inject. "session"
// and "lifetime" use no time predicate (session id filter / no filter), so they
// have no trunc unit here.
const QUOTA_WINDOW_TRUNC: Record<Quota["window"], "day" | "week" | "month" | null> = {
  session: null,
  day: "day",
  week: "week",
  month: "month",
  lifetime: null,
};

/**
 * The total already accrued toward a quota in its window, summed from
 * quota_usage over (agent, skill_ref, quota_key) plus the window predicate:
 * "session" filters to this session; "day"/"week"/"month" filter to
 * occurred_at >= date_trunc(<unit>, now()); "lifetime" applies no time filter.
 * The trunc unit comes from a fixed lookup, never from the raw enum value.
 */
async function quotaPriorUsed(
  client: PoolClient,
  args: { agentId: string; sessionId: string; skillRef: string; quota: Quota },
): Promise<number> {
  const { agentId, sessionId, skillRef, quota } = args;
  const base =
    "SELECT coalesce(sum(amount), 0) AS used FROM quota_usage " +
    "WHERE agent_id = $1 AND skill_ref = $2 AND quota_key = $3";
  let rows: { used: string }[];
  if (quota.window === "session") {
    ({ rows } = await client.query<{ used: string }>(`${base} AND session_id = $4`, [
      agentId,
      skillRef,
      quota.key,
      sessionId,
    ]));
  } else if (quota.window === "lifetime") {
    ({ rows } = await client.query<{ used: string }>(base, [agentId, skillRef, quota.key]));
  } else {
    // Only a literal trunc unit from the fixed lookup is interpolated.
    const unit = QUOTA_WINDOW_TRUNC[quota.window]!;
    ({ rows } = await client.query<{ used: string }>(
      `${base} AND occurred_at >= date_trunc('${unit}', now())`,
      [agentId, skillRef, quota.key],
    ));
  }
  return Number(rows[0]!.used);
}

async function inTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function openSession(
  pool: Pool,
  input: {
    label: string;
    externalRef?: string;
    actor: Actor;
    userId?: string;
    redact?: RedactionHook;
  },
): Promise<ProxySessionRow> {
  return inTx(pool, async (client) => {
    const { rows } = await client.query<ProxySessionRow>(
      `INSERT INTO proxy_sessions (label, external_ref, created_by_user_id)
       VALUES ($1, $2, $3) RETURNING ${SESSION_COLUMNS}`,
      [input.label, input.externalRef ?? null, input.userId ?? null],
    );
    const session = rows[0]!;
    // label / externalRef are caller-supplied free text: redact at write time
    // like every other proxy audit payload (the check/record/denial paths do).
    const redact = input.redact ?? resolveRedactionHook();
    await recordEvent(client, {
      eventType: "proxy.session.opened",
      actor: input.actor,
      entityType: "proxy_session",
      entityId: session.id,
      payload: redact({
        sessionId: session.id,
        label: input.label,
        externalRef: input.externalRef ?? null,
      }),
    });
    return session;
  });
}

/**
 * The authorization checkpoint. Same checks as the flow engine's enforce():
 * agent active, skill exists and is published, an unrevoked grant — plus SoD
 * against the roles that already acted (decision = 'allowed') in this
 * session. High-risk skills are categorically denied here: the proxy has no
 * approval gates, so they must run through a governed flow that has one.
 * Fail closed: anything ambiguous is a denial.
 */
export async function checkAndAuthorize(
  pool: Pool,
  input: {
    sessionId: string;
    agentName: string;
    skillRef: string;
    input?: Record<string, unknown>;
    actor: Actor;
    redact?: RedactionHook;
  },
): Promise<ProxyCheckResult> {
  const redact = input.redact ?? resolveRedactionHook();
  return inTx(pool, async (client) => {
    // Lock the session row: concurrent checks in one session serialize, so
    // the SoD actor set cannot be raced past.
    const session = await client.query<{ status: string }>(
      "SELECT status FROM proxy_sessions WHERE id = $1 FOR UPDATE",
      [input.sessionId],
    );
    if (!session.rows[0]) {
      throw new ProxyError(404, `proxy session ${input.sessionId} not found`);
    }
    if (session.rows[0].status !== "open") {
      throw new ProxyError(409, `proxy session ${input.sessionId} is closed`);
    }

    const deny = (
      code: ProxyDenialCode,
      reason: string,
      agent?: { id: string; role_id: string },
      skillId?: string,
    ) => recordDenial(client, { ...input, code, reason, agent, skillId, redact });

    const agents = await client.query<{ id: string; role_id: string; status: string }>(
      "SELECT id, role_id, status FROM agents WHERE name = $1",
      [input.agentName],
    );
    const agent = agents.rows[0];
    if (!agent) {
      // No agents row to reference: the audit event alone is the record.
      return deny("agent_not_found", `agent "${input.agentName}" does not exist`);
    }
    if (agent.status !== "active") {
      return deny("agent_not_active", `agent "${input.agentName}" is ${agent.status}`, agent);
    }

    const { name, version } = parseSkillRef(input.skillRef);
    // Canonicalization guard. The skill is resolved by (name, version), but the
    // per-skill limit and the invocation count are keyed by the ref STRING. A
    // non-canonical ref ("pay@01", "pay@1@x", "pay@1 ") resolves to the same
    // skill yet misses the limit-map key, silently skipping the ceiling, and
    // splits the invocation count. Require the ref to be exactly canonical so the
    // resolve key-space and the limit key-space cannot disagree.
    if (!Number.isInteger(version) || version < 1 || `${name}@${version}` !== input.skillRef) {
      return deny(
        "skill_not_found",
        `"${input.skillRef}" is not a valid skill reference (use name@version, e.g. pay@1)`,
        agent,
      );
    }
    const skills = await client.query<{ id: string; status: string; risk_tier: string }>(
      "SELECT id, status, risk_tier FROM skills WHERE name = $1 AND version = $2",
      [name, version],
    );
    const skill = skills.rows[0];
    if (!skill) {
      return deny("skill_not_found", `skill "${input.skillRef}" does not exist`, agent);
    }
    if (skill.status !== "published") {
      return deny(
        "skill_deprecated",
        `skill "${input.skillRef}" is ${skill.status}`,
        agent,
        skill.id,
      );
    }

    // Deny by default: an exact, unrevoked grant of this skill version to the
    // agent's role is required. No grant, no execution — there is no bypass.
    const grant = await client.query(
      `SELECT 1 FROM role_skill_grants
        WHERE role_id = $1 AND skill_id = $2 AND revoked_at IS NULL LIMIT 1`,
      [agent.role_id, skill.id],
    );
    if (grant.rows.length === 0) {
      return deny(
        "skill_not_granted",
        `skill "${input.skillRef}" is not granted to the role of agent "${input.agentName}"`,
        agent,
        skill.id,
      );
    }

    if (skill.risk_tier === "high") {
      return deny(
        "high_risk_requires_gate",
        `skill "${input.skillRef}" is high-risk and cannot run through the proxy; ` +
          "run it in a governed flow with a preceding approval gate",
        agent,
        skill.id,
      );
    }

    const sod = await checkSodConflict(client, agent.role_id, {
      proxySessionId: input.sessionId,
    });
    if (sod) {
      return deny(
        "sod_violation",
        `segregation of duties: the role of agent "${input.agentName}" conflicts with ` +
          `role ${sod.priorRoleId} which already acted in this session` +
          (sod.description ? ` (${sod.description})` : ""),
        agent,
        skill.id,
      );
    }

    // Per-skill role limits, scoped to this session: invocations already
    // ALLOWED here count toward the cap (denied attempts never acted), and
    // amount limits fail closed on missing/unreadable inputs.
    const skillLimits = (await getRoleLimits(client, agent.role_id)).skills?.[input.skillRef];
    if (skillLimits) {
      const prior = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM proxy_actions
          WHERE session_id = $1 AND skill_ref = $2 AND decision = 'allowed'`,
        [input.sessionId, input.skillRef],
      );
      try {
        assertSkillLimits(skillLimits, prior.rows[0]!.n, input.input ?? {}, input.skillRef);
        // Windowed quotas: per quota, this call's contribution (fails closed on
        // missing/non-numeric/negative input) plus the total already accrued in
        // its window must not exceed the ceiling. The accrual SUM counts only
        // prior ALLOWED actions (denied attempts never wrote a quota_usage row),
        // so a denial here cannot itself raise the running total. The matching
        // INSERTs happen only on allow, below, in this same transaction.
        if (skillLimits.quotas) {
          for (const quota of skillLimits.quotas) {
            const contribution = quotaContribution(quota, input.input ?? {}, input.skillRef);
            const priorUsed = await quotaPriorUsed(client, {
              agentId: agent.id,
              sessionId: input.sessionId,
              skillRef: input.skillRef,
              quota,
            });
            assertQuota(quota, priorUsed, contribution, input.skillRef);
          }
        }
      } catch (err) {
        if (err instanceof LimitViolationError) {
          return deny(err.code, err.message, agent, skill.id);
        }
        throw err;
      }
    }

    const action = await client.query<{ id: string }>(
      `INSERT INTO proxy_actions
         (session_id, agent_id, role_id_snapshot, skill_id, skill_ref, decision)
       VALUES ($1, $2, $3, $4, $5, 'allowed') RETURNING id`,
      [input.sessionId, agent.id, agent.role_id, skill.id, input.skillRef],
    );
    const checkId = action.rows[0]!.id;
    // Accrue each quota's contribution against this ALLOWED action, in the same
    // transaction as the proxy_actions row. Only on allow, only for configured
    // quotas: a denial returned before this point wrote no quota_usage row, so
    // denied attempts never count toward any running total. Re-derives the
    // contribution with the same fail-closed guards used in the check above.
    if (skillLimits?.quotas) {
      for (const quota of skillLimits.quotas) {
        const contribution = quotaContribution(quota, input.input ?? {}, input.skillRef);
        await client.query(
          `INSERT INTO quota_usage
             (proxy_action_id, agent_id, session_id, skill_ref, quota_key, amount, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [checkId, agent.id, input.sessionId, input.skillRef, quota.key, contribution],
        );
      }
    }
    await recordEvent(client, {
      eventType: "proxy.check.allowed",
      actor: input.actor,
      entityType: "proxy_session",
      entityId: input.sessionId,
      payload: redact({
        sessionId: input.sessionId,
        checkId,
        agentName: input.agentName,
        skillRef: input.skillRef,
        ...(input.input !== undefined ? { input: input.input } : {}),
      }),
    });
    return { allowed: true, checkId };
  });
}

/**
 * Records a denial: a proxy_actions row (whenever the agent resolved — an
 * unknown agent cannot be referenced by FK; the audit event is then the only
 * record) plus the enforcement audit event, mirroring the flow engine's
 * event types with {via: 'proxy'}. Denied rows never join the SoD actor set.
 */
async function recordDenial(
  client: PoolClient,
  args: {
    sessionId: string;
    agentName: string;
    skillRef: string;
    actor: Actor;
    code: ProxyDenialCode;
    reason: string;
    agent?: { id: string; role_id: string } | undefined;
    skillId?: string | undefined;
    redact?: RedactionHook | undefined;
  },
): Promise<ProxyCheckResult> {
  const redact = args.redact ?? resolveRedactionHook();
  if (args.agent) {
    await client.query(
      `INSERT INTO proxy_actions
         (session_id, agent_id, role_id_snapshot, skill_id, skill_ref, decision)
       VALUES ($1, $2, $3, $4, $5, 'denied')`,
      [args.sessionId, args.agent.id, args.agent.role_id, args.skillId ?? null, args.skillRef],
    );
  }
  await recordEvent(client, {
    eventType:
      args.code === "sod_violation"
        ? "enforcement.sod_violation"
        : args.code.startsWith("limit_")
          ? "enforcement.limit_violation"
          : "enforcement.blocked",
    actor: args.actor,
    entityType: "proxy_session",
    entityId: args.sessionId,
    payload: redact({
      via: "proxy",
      sessionId: args.sessionId,
      agentName: args.agentName,
      skillRef: args.skillRef,
      code: args.code,
      reason: args.reason,
    }),
  });
  return { allowed: false, code: args.code, reason: args.reason };
}

/**
 * Appends the outcome of an allowed call to the evidentiary record. Accepted
 * even after the session closes: the authorization already happened while it
 * was open, and refusing the evidence would only erase what occurred.
 */
export async function recordResult(
  pool: Pool,
  input: {
    sessionId: string;
    checkId: string;
    output?: unknown;
    error?: unknown;
    actor: Actor;
    redact?: RedactionHook;
  },
): Promise<void> {
  const redact = input.redact ?? resolveRedactionHook();
  await inTx(pool, async (client) => {
    const session = await client.query("SELECT 1 FROM proxy_sessions WHERE id = $1", [
      input.sessionId,
    ]);
    if (!session.rows[0]) {
      throw new ProxyError(404, `proxy session ${input.sessionId} not found`);
    }
    const action = await client.query<{ decision: string; skill_ref: string }>(
      "SELECT decision, skill_ref FROM proxy_actions WHERE id = $1 AND session_id = $2",
      [input.checkId, input.sessionId],
    );
    if (!action.rows[0]) {
      throw new ProxyError(404, `check ${input.checkId} not found in session ${input.sessionId}`);
    }
    if (action.rows[0].decision !== "allowed") {
      throw new ProxyError(409, `check ${input.checkId} was denied; it has no result to record`);
    }
    await recordEvent(client, {
      eventType: "proxy.result.recorded",
      actor: input.actor,
      entityType: "proxy_session",
      entityId: input.sessionId,
      payload: redact({
        sessionId: input.sessionId,
        checkId: input.checkId,
        skillRef: action.rows[0].skill_ref,
        ...(input.output !== undefined ? { output: input.output } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
      }),
    });
  });
}

export async function closeSession(
  pool: Pool,
  input: { sessionId: string; actor: Actor; redact?: RedactionHook },
): Promise<ProxySessionRow> {
  return inTx(pool, async (client) => {
    const { rows } = await client.query<ProxySessionRow>(
      `UPDATE proxy_sessions SET status = 'closed', closed_at = now()
        WHERE id = $1 AND status = 'open' RETURNING ${SESSION_COLUMNS}`,
      [input.sessionId],
    );
    const session = rows[0];
    if (!session) {
      const exists = await client.query("SELECT 1 FROM proxy_sessions WHERE id = $1", [
        input.sessionId,
      ]);
      throw exists.rows[0]
        ? new ProxyError(409, `proxy session ${input.sessionId} is already closed`)
        : new ProxyError(404, `proxy session ${input.sessionId} not found`);
    }
    await recordEvent(client, {
      eventType: "proxy.session.closed",
      actor: input.actor,
      entityType: "proxy_session",
      entityId: session.id,
      payload: (input.redact ?? resolveRedactionHook())({
        sessionId: session.id,
        label: session.label,
      }),
    });
    return session;
  });
}
