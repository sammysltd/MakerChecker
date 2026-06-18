import { isApprovalGate, SKILL_REF_PATTERN, type FlowDefinition } from "@makerchecker/shared";
import { Type, type Static } from "@sinclair/typebox";
import { Ajv } from "ajv";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import { recordEvent, type Actor } from "../audit/writer.js";
import { FlowValidationError, publishFlowVersion } from "../engine/flows.js";
import type { EngineContext } from "../engine/orchestrator.js";

/**
 * Admin CRUD for the governed entities: roles, SoD constraints, skills,
 * grants, agents, flows, triggers, webhook endpoints.
 *
 * Conventions enforced here:
 * - Audit-first: every mutation records its audit event in the SAME
 *   transaction as the state change, with the authenticated user as actor.
 * - Nothing is deleted or edited in place: skills/flows are immutable once
 *   published (405 on attempts), grants/constraints are revoked, never erased.
 */

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_PATTERN }) });
type IdParamsT = Static<typeof IdParams>;

const JsonObject = Type.Record(Type.String(), Type.Unknown());

/**
 * roles.limits is an ENFORCED contract (see engine/limits.ts): it is read and
 * checked immediately before every skill invocation and LLM call, and it fails
 * closed when a value is unreadable. That runtime fail-closed is the last line
 * of defense, but a malformed or mis-targeted ceiling that only ever denies at
 * runtime is a silent footgun: the admin believes they configured a budget
 * that in fact governs nothing (or denies everything). This schema rejects such
 * a limits object at WRITE time with a 400, so a saved limit is always a limit
 * that can actually take effect. The shape mirrors `RoleLimits`/`SkillLimitConfig`
 * in engine/limits.ts exactly; keep the two in lockstep.
 *
 * `additionalProperties: false` at every level rejects unknown nested keys (a
 * typo'd `maxInvocations` would otherwise silently never enforce). The `skills`
 * map key is constrained to a real skill ref shape (`name@version`, matching the
 * skill name pattern in PublishSkillBody) so a mis-targeted ceiling keyed by
 * something that can never match a runtime skillRef is rejected rather than
 * saved as dead config.
 */
// Use the canonical skill-ref pattern (no leading-zero / positive-integer
// version) so a limit keyed "pay@01" is rejected at write time rather than saved
// as dead config that never matches the canonical runtime ref.
const SkillRefPattern = SKILL_REF_PATTERN;

const SkillLimitConfig = Type.Object(
  {
    maxInvocationsPerRun: Type.Optional(Type.Integer({ minimum: 0 })),
    maxAmountPerInvocation: Type.Optional(Type.Number({ minimum: 0 })),
    amountField: Type.Optional(Type.String({ minLength: 1 })),
    // Destination allowlist: the call's `field` must be a string in `values`.
    // `minItems: 1` rejects an empty list at write time (an empty allowlist would
    // deny everything — a footgun the runtime also fails closed on).
    allowlist: Type.Optional(
      Type.Object(
        {
          field: Type.String({ minLength: 1 }),
          values: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    // Path scope: the call's `field` must be a path under `prefix`, no traversal.
    // The prefix must be ABSOLUTE and contain no `..` segment: a relative or
    // upward-escaping prefix has no well-defined containment root and is a
    // footgun (rejected at write time; isPathWithinPrefix also fails closed on it).
    pathScope: Type.Optional(
      Type.Object(
        {
          field: Type.String({ minLength: 1 }),
          prefix: Type.String({ minLength: 1, pattern: "^/(?!.*/\\.\\.(?:/|$)).*$" }),
        },
        { additionalProperties: false },
      ),
    ),
    // Windowed quotas: a running total of `field` (or a count when omitted)
    // accrued across this skill's allowed invocations within `window`, denied
    // when it would exceed `max`. The window enum is fixed; the runtime maps it
    // to a SQL truncation unit by lookup (never interpolating the raw value).
    quotas: Type.Optional(
      Type.Array(
        Type.Object(
          {
            key: Type.String({ minLength: 1 }),
            field: Type.Optional(Type.String({ minLength: 1 })),
            max: Type.Number({ minimum: 0 }),
            window: Type.Union([
              Type.Literal("session"),
              Type.Literal("day"),
              Type.Literal("week"),
              Type.Literal("month"),
              Type.Literal("lifetime"),
            ]),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

const RoleLimits = Type.Object(
  {
    run: Type.Optional(
      Type.Object(
        {
          maxSkillInvocations: Type.Optional(Type.Integer({ minimum: 0 })),
          maxTokens: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    skills: Type.Optional(
      Type.Record(Type.String({ pattern: SkillRefPattern }), SkillLimitConfig, {
        additionalProperties: false,
      }),
    ),
  },
  { additionalProperties: false },
);

const CreateRoleBody = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    limits: Type.Optional(RoleLimits),
  },
  { additionalProperties: false },
);

/**
 * A STRICT, non-coercing validator for roles.limits. Fastify's route-body ajv
 * runs with `coerceTypes: "array"` (the framework default), which silently
 * rewrites types before the schema check: `"5"` -> 5, `true` -> 1, `null` -> 0,
 * `[5]` -> 5, and `7` -> "7" for a string field. For ordinary DTO fields that is
 * a convenience, but a limits ceiling is an enforced security budget: a coerced
 * `null` -> 0 silently turns "no limit" into "deny everything", and a coerced
 * `7` -> "7" silently retargets `amountField`. So the limits object is validated
 * with coercion OFF in a `preValidation` hook (which sees the RAW parsed body,
 * before the route ajv coerces it in place): the value must already be the exact
 * declared type or the write is rejected 400. This pairs with the route schema
 * (which rejects negatives, floats, unknown keys, and mis-targeted skill refs)
 * and the runtime fail-closed checks in engine/limits.ts (the final defense).
 */
const strictAjv = new Ajv({ coerceTypes: false, useDefaults: false, allErrors: false });
const validateRoleLimits = strictAjv.compile(RoleLimits);

/**
 * preValidation gate for POST /roles: strict-checks `limits` against
 * `RoleLimits` with coercion off, BEFORE the route's coercing body validation
 * runs. Only the `limits` shape is inspected here; name/description and the rest
 * of the body are left to the route schema. A bad `limits` is a 400.
 */
async function validateRoleLimitsHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = req.body;
  if (typeof body !== "object" || body === null) return;
  const limits = (body as { limits?: unknown }).limits;
  if (limits === undefined) return;
  if (!validateRoleLimits(limits)) {
    await reply
      .status(400)
      .send({ error: "invalid role limits", details: validateRoleLimits.errors });
  }
}

const CreateSodBody = Type.Object(
  {
    roleAId: Type.String({ pattern: UUID_PATTERN }),
    roleBId: Type.String({ pattern: UUID_PATTERN }),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const PublishSkillBody = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    version: Type.Integer({ minimum: 1 }),
    description: Type.String(),
    inputSchema: JsonObject,
    outputSchema: JsonObject,
    implementation: JsonObject,
    riskTier: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  },
  { additionalProperties: false },
);

const CreateGrantBody = Type.Object(
  {
    roleId: Type.String({ pattern: UUID_PATTERN }),
    skillId: Type.String({ pattern: UUID_PATTERN }),
  },
  { additionalProperties: false },
);

const CreateAgentBody = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    roleId: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
    roleName: Type.Optional(Type.String({ minLength: 1 })),
    modelConfig: Type.Optional(JsonObject),
  },
  { additionalProperties: false },
);

const UpdateAgentBody = Type.Object(
  {
    description: Type.Optional(Type.String()),
    modelConfig: Type.Optional(JsonObject),
    roleId: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  },
  { additionalProperties: false },
);

const AgentStatusBody = Type.Object(
  {
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("suspended"),
      Type.Literal("retired"),
    ]),
  },
  { additionalProperties: false },
);

const PublishFlowBody = Type.Object(
  { definition: Type.Unknown() },
  { additionalProperties: false },
);

const CreateTriggerBody = Type.Object(
  {
    flowName: Type.String({ minLength: 1 }),
    type: Type.Union([Type.Literal("cron"), Type.Literal("event"), Type.Literal("manual")]),
    config: Type.Optional(JsonObject),
  },
  { additionalProperties: false },
);

const UpdateTriggerBody = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false },
);

const CreateWebhookEndpointBody = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    secret: Type.String({ minLength: 8 }),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** The audited actor for a request: the authenticated user, else the anonymous api actor. */
export function actorOf(req: FastifyRequest): Actor {
  const user = req.authUser;
  return user ? { type: "user", id: user.id, name: user.email } : { type: "user", name: "api" };
}

/**
 * True when authentication is switched off (compose demo mode). In that mode
 * there is no `authUser` to gate against, so the operator has explicitly opted
 * the whole instance out of authorization — admin gating and object-level
 * scoping are bypassed. Everywhere else we fail closed.
 */
export function authDisabled(): boolean {
  return process.env.MAKERCHECKER_AUTH_DISABLED === "1";
}

/**
 * Deny-by-default admin guard for mutating admin CRUD routes. Loaded into
 * req.authUser by the API auth hook, `is_admin` was never enforced — this is
 * the enforcement point. A non-admin (or, defensively, an unauthenticated
 * request when auth is on) gets a 403; only `is_admin === true` proceeds. In
 * MAKERCHECKER_AUTH_DISABLED mode the check is skipped, like the auth hook.
 *
 * Used as a route `preHandler`: it runs after the API auth hook (which has
 * already populated/ rejected req.authUser) and before the handler body, so a
 * denied request never reaches the state-mutating code.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (authDisabled()) return;
  if (req.authUser?.is_admin === true) return;
  await reply.status(403).send({ error: "admin privileges required" });
}

/**
 * Read-path masking of a stored flow definition for non-privileged callers.
 *
 * A gate's `approvals.approver_emails` is the list of NAMED human approver
 * identities — PII that no non-admin needs to read a flow's structure. This
 * shapes the RESPONSE only: it deep-clones the definition and drops the
 * `approver_emails` key from every approval gate that carries one, leaving the
 * gate's title and the rest of its identity config (min_approvals,
 * forbid_requester) intact. The stored row and every enforcement path keep the
 * full list — only the bytes returned to a non-admin change.
 *
 * We DROP the key rather than emit a placeholder so the response shape exactly
 * matches an open-pool gate (one that never named approvers): a non-admin
 * cannot distinguish "no list" from "list withheld", which is the point — the
 * identities, and even the count of them, stay private.
 */
function maskApproverEmails(definition: unknown): unknown {
  if (typeof definition !== "object" || definition === null) return definition;
  const def = definition as FlowDefinition;
  if (!Array.isArray(def.steps)) return definition;
  return {
    ...def,
    steps: def.steps.map((step) => {
      if (!isApprovalGate(step) || !step.approvals?.approver_emails) return step;
      const { approver_emails: _omitted, ...approvals } = step.approvals;
      return { ...step, approvals };
    }),
  };
}

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    return String((err as { code?: unknown }).code);
  }
  return undefined;
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

export function registerAdminRoutes(app: FastifyInstance, ctx: EngineContext): void {
  const { pool } = ctx;

  // ---------------------------------------------------------------- roles

  app.post<{ Body: Static<typeof CreateRoleBody> }>(
    "/roles",
    {
      // requireAdmin first (deny by default before inspecting input), then
      // validateRoleLimitsHook in preValidation: it runs before the route ajv
      // coerces the body, so a wrong-typed limit is rejected with its raw value.
      preValidation: [requireAdmin, validateRoleLimitsHook],
      schema: { operationId: "createRole", tags: ["roles"], body: CreateRoleBody },
    },
    async (req, reply) => {
      try {
        const role = await inTx(pool, async (client) => {
          const { rows } = await client.query(
            `INSERT INTO roles (name, description, limits)
             VALUES ($1, $2, $3) RETURNING id, name, description, limits, created_at`,
            [req.body.name, req.body.description ?? "", JSON.stringify(req.body.limits ?? {})],
          );
          const created = rows[0]!;
          await recordEvent(client, {
            eventType: "role.created",
            actor: actorOf(req),
            entityType: "role",
            entityId: created.id as string,
            payload: { name: req.body.name, description: req.body.description ?? "" },
          });
          return created;
        });
        return reply.status(201).send({ role });
      } catch (err) {
        if (pgErrorCode(err) === "23505") {
          return reply.status(409).send({ error: `role "${req.body.name}" already exists` });
        }
        throw err;
      }
    },
  );

  app.get(
    "/roles",
    { schema: { operationId: "listRoles", tags: ["roles"] } },
    async () => {
      const { rows } = await pool.query(
        `SELECT r.id, r.name, r.description, r.limits, r.created_at,
                count(g.id) FILTER (WHERE g.revoked_at IS NULL)::int AS active_grant_count
           FROM roles r
           LEFT JOIN role_skill_grants g ON g.role_id = r.id
          GROUP BY r.id
          ORDER BY r.name`,
      );
      return { roles: rows };
    },
  );

  app.get<{ Params: IdParamsT }>(
    "/roles/:id",
    { schema: { operationId: "getRole", tags: ["roles"], params: IdParams } },
    async (req, reply) => {
      const role = await pool.query(
        "SELECT id, name, description, limits, created_at FROM roles WHERE id = $1",
        [req.params.id],
      );
      if (!role.rows[0]) return reply.status(404).send({ error: "role not found" });
      const grants = await pool.query(
        `SELECT g.id, s.name AS skill, s.version, s.risk_tier,
                g.created_at AS granted_at, g.revoked_at
           FROM role_skill_grants g
           JOIN skills s ON s.id = g.skill_id
          WHERE g.role_id = $1
          ORDER BY g.created_at`,
        [req.params.id],
      );
      const sod = await pool.query(
        `SELECT sc.id, sc.description, sc.revoked_at,
                ra.name AS role_a, rb.name AS role_b
           FROM sod_constraints sc
           JOIN roles ra ON ra.id = sc.role_a_id
           JOIN roles rb ON rb.id = sc.role_b_id
          WHERE sc.role_a_id = $1 OR sc.role_b_id = $1
          ORDER BY sc.created_at`,
        [req.params.id],
      );
      return { role: role.rows[0], grants: grants.rows, sodConstraints: sod.rows };
    },
  );

  // Roles are versioned-forever facts; deletion is not a thing.
  app.delete<{ Params: IdParamsT }>(
    "/roles/:id",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "deleteRoleNotAllowed", tags: ["roles"], params: IdParams },
    },
    async (_req, reply) =>
      reply.status(405).send({ error: "roles cannot be deleted; they are kept forever" }),
  );

  // -------------------------------------------------------- sod constraints

  app.post<{ Body: Static<typeof CreateSodBody> }>(
    "/sod-constraints",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "createSodConstraint", tags: ["sod"], body: CreateSodBody },
    },
    async (req, reply) => {
      if (req.body.roleAId === req.body.roleBId) {
        return reply
          .status(400)
          .send({ error: "a role cannot be SoD-constrained against itself" });
      }
      const roles = await pool.query("SELECT id FROM roles WHERE id = ANY($1::uuid[])", [
        [req.body.roleAId, req.body.roleBId],
      ]);
      if (roles.rows.length !== 2) {
        return reply.status(404).send({ error: "one or both roles not found" });
      }
      const constraint = await inTx(pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
           VALUES (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), $3)
           RETURNING id, role_a_id, role_b_id, scope, description, created_at, revoked_at`,
          [req.body.roleAId, req.body.roleBId, req.body.description ?? ""],
        );
        const created = rows[0]!;
        await recordEvent(client, {
          eventType: "sod_constraint.created",
          actor: actorOf(req),
          entityType: "sod_constraint",
          entityId: created.id as string,
          payload: {
            roleAId: created.role_a_id as string,
            roleBId: created.role_b_id as string,
            description: req.body.description ?? "",
          },
        });
        return created;
      });
      return reply.status(201).send({ sodConstraint: constraint });
    },
  );

  app.post<{ Params: IdParamsT }>(
    "/sod-constraints/:id/revoke",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "revokeSodConstraint", tags: ["sod"], params: IdParams },
    },
    async (req, reply) => {
      const result = await inTx(pool, async (client) => {
        const { rows } = await client.query(
          `UPDATE sod_constraints SET revoked_at = now()
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING id, role_a_id, role_b_id, description, created_at, revoked_at`,
          [req.params.id],
        );
        if (!rows[0]) return null;
        await recordEvent(client, {
          eventType: "sod_constraint.revoked",
          actor: actorOf(req),
          entityType: "sod_constraint",
          entityId: req.params.id,
          payload: {},
        });
        return rows[0];
      });
      if (result) return { sodConstraint: result };
      const exists = await pool.query("SELECT 1 FROM sod_constraints WHERE id = $1", [
        req.params.id,
      ]);
      return exists.rows.length > 0
        ? reply.status(409).send({ error: "constraint already revoked" })
        : reply.status(404).send({ error: "constraint not found" });
    },
  );

  // ---------------------------------------------------------------- skills

  app.post<{ Body: Static<typeof PublishSkillBody> }>(
    "/skills",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "publishSkill", tags: ["skills"], body: PublishSkillBody },
    },
    async (req, reply) => {
      try {
        const skill = await inTx(pool, async (client) => {
          const { rows } = await client.query(
            `INSERT INTO skills
               (name, version, description, input_schema, output_schema, implementation,
                risk_tier, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, name, version, description, input_schema, output_schema,
                       implementation, risk_tier, status, created_at`,
            [
              req.body.name,
              req.body.version,
              req.body.description,
              JSON.stringify(req.body.inputSchema),
              JSON.stringify(req.body.outputSchema),
              JSON.stringify(req.body.implementation),
              req.body.riskTier,
              req.authUser?.id ?? null,
            ],
          );
          const created = rows[0]!;
          await recordEvent(client, {
            eventType: "skill.published",
            actor: actorOf(req),
            entityType: "skill",
            entityId: created.id as string,
            payload: {
              name: req.body.name,
              version: req.body.version,
              riskTier: req.body.riskTier,
            },
          });
          return created;
        });
        return reply.status(201).send({ skill });
      } catch (err) {
        if (pgErrorCode(err) === "23505") {
          return reply.status(409).send({
            error: `skill "${req.body.name}@${req.body.version}" already exists; publish a new version`,
          });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: IdParamsT }>(
    "/skills/:id/deprecate",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "deprecateSkill", tags: ["skills"], params: IdParams },
    },
    async (req, reply) => {
      const result = await inTx(pool, async (client) => {
        const { rows } = await client.query(
          `UPDATE skills SET status = 'deprecated'
            WHERE id = $1 AND status = 'published'
            RETURNING id, name, version, risk_tier, status, created_at`,
          [req.params.id],
        );
        if (!rows[0]) return null;
        await recordEvent(client, {
          eventType: "skill.deprecated",
          actor: actorOf(req),
          entityType: "skill",
          entityId: req.params.id,
          payload: { name: rows[0].name as string, version: rows[0].version as number },
        });
        return rows[0];
      });
      if (result) return { skill: result };
      const exists = await pool.query("SELECT 1 FROM skills WHERE id = $1", [req.params.id]);
      return exists.rows.length > 0
        ? reply.status(409).send({ error: "skill already deprecated" })
        : reply.status(404).send({ error: "skill not found" });
    },
  );

  app.get(
    "/skills",
    { schema: { operationId: "listSkills", tags: ["skills"] } },
    async () => {
      const { rows } = await pool.query(
        `SELECT id, name, version, description, risk_tier, status, created_at
           FROM skills ORDER BY name, version`,
      );
      return { skills: rows };
    },
  );

  app.get<{ Params: IdParamsT }>(
    "/skills/:id",
    { schema: { operationId: "getSkill", tags: ["skills"], params: IdParams } },
    async (req, reply) => {
      const skill = await pool.query(
        `SELECT id, name, version, description, input_schema, output_schema,
                implementation, risk_tier, status, created_at
           FROM skills WHERE id = $1`,
        [req.params.id],
      );
      if (!skill.rows[0]) return reply.status(404).send({ error: "skill not found" });
      const history = await pool.query(
        `SELECT g.id, r.name AS role, g.created_at AS granted_at, gb.email AS granted_by,
                g.revoked_at, rb.email AS revoked_by
           FROM role_skill_grants g
           JOIN roles r ON r.id = g.role_id
           LEFT JOIN users gb ON gb.id = g.granted_by_user_id
           LEFT JOIN users rb ON rb.id = g.revoked_by_user_id
          WHERE g.skill_id = $1
          ORDER BY g.created_at`,
        [req.params.id],
      );
      // The skill `implementation` is admin-authored config that can legitimately
      // carry secrets (an http skill's `x-...` auth header, a token in a URL).
      // Like webhook secrets, it is privileged: non-admins get only its `type`
      // discriminator, never the full command/url/headers.
      const privileged = authDisabled() || req.authUser?.is_admin === true;
      const row = skill.rows[0] as Record<string, unknown>;
      const skillOut = privileged
        ? row
        : {
            ...row,
            implementation: { type: (row.implementation as { type?: string } | null)?.type },
          };
      return { skill: skillOut, grantHistory: history.rows };
    },
  );

  // Published skills are immutable (DB trigger enforces it too); changes mean
  // a new version. Reject edit attempts loudly.
  app.patch<{ Params: IdParamsT }>(
    "/skills/:id",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "updateSkillNotAllowed", tags: ["skills"], params: IdParams },
    },
    async (_req, reply) =>
      reply.status(405).send({
        error: "skills are immutable once published; publish a new version or deprecate",
      }),
  );

  // ---------------------------------------------------------------- grants

  app.post<{ Body: Static<typeof CreateGrantBody> }>(
    "/grants",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "createGrant", tags: ["grants"], body: CreateGrantBody },
    },
    async (req, reply) => {
      const role = await pool.query("SELECT 1 FROM roles WHERE id = $1", [req.body.roleId]);
      if (role.rows.length === 0) return reply.status(404).send({ error: "role not found" });
      const skill = await pool.query("SELECT name, version FROM skills WHERE id = $1", [
        req.body.skillId,
      ]);
      if (!skill.rows[0]) return reply.status(404).send({ error: "skill not found" });

      const active = await pool.query(
        `SELECT id FROM role_skill_grants
          WHERE role_id = $1 AND skill_id = $2 AND revoked_at IS NULL`,
        [req.body.roleId, req.body.skillId],
      );
      if (active.rows[0]) {
        return reply
          .status(409)
          .send({ error: "an active identical grant already exists", grantId: active.rows[0].id });
      }

      const grant = await inTx(pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO role_skill_grants (role_id, skill_id, granted_by_user_id)
           VALUES ($1, $2, $3)
           RETURNING id, role_id, skill_id, created_at, revoked_at`,
          [req.body.roleId, req.body.skillId, req.authUser?.id ?? null],
        );
        const created = rows[0]!;
        await recordEvent(client, {
          eventType: "grant.created",
          actor: actorOf(req),
          entityType: "grant",
          entityId: created.id as string,
          payload: {
            roleId: req.body.roleId,
            skillId: req.body.skillId,
            skill: `${skill.rows[0]!.name}@${skill.rows[0]!.version}`,
          },
        });
        return created;
      });
      return reply.status(201).send({ grant });
    },
  );

  app.post<{ Params: IdParamsT }>(
    "/grants/:id/revoke",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "revokeGrant", tags: ["grants"], params: IdParams },
    },
    async (req, reply) => {
      const result = await inTx(pool, async (client) => {
        const { rows } = await client.query(
          `UPDATE role_skill_grants SET revoked_at = now(), revoked_by_user_id = $2
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING id, role_id, skill_id, created_at, revoked_at`,
          [req.params.id, req.authUser?.id ?? null],
        );
        if (!rows[0]) return null;
        await recordEvent(client, {
          eventType: "grant.revoked",
          actor: actorOf(req),
          entityType: "grant",
          entityId: req.params.id,
          payload: {
            roleId: rows[0].role_id as string,
            skillId: rows[0].skill_id as string,
          },
        });
        return rows[0];
      });
      if (result) return { grant: result };
      const exists = await pool.query("SELECT 1 FROM role_skill_grants WHERE id = $1", [
        req.params.id,
      ]);
      return exists.rows.length > 0
        ? reply.status(409).send({ error: "grant already revoked" })
        : reply.status(404).send({ error: "grant not found" });
    },
  );

  // ---------------------------------------------------------------- agents

  app.post<{ Body: Static<typeof CreateAgentBody> }>(
    "/agents",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "createAgent", tags: ["agents"], body: CreateAgentBody },
    },
    async (req, reply) => {
      if (req.body.roleId === undefined && req.body.roleName === undefined) {
        return reply.status(400).send({ error: "either roleId or roleName is required" });
      }
      const role =
        req.body.roleId !== undefined
          ? await pool.query<{ id: string }>("SELECT id FROM roles WHERE id = $1", [
              req.body.roleId,
            ])
          : await pool.query<{ id: string }>("SELECT id FROM roles WHERE name = $1", [
              req.body.roleName,
            ]);
      if (!role.rows[0]) return reply.status(404).send({ error: "role not found" });
      const roleId = role.rows[0].id;

      try {
        const agent = await inTx(pool, async (client) => {
          const { rows } = await client.query(
            `INSERT INTO agents (name, description, role_id, model_config)
             VALUES ($1, $2, $3, $4)
             RETURNING id, name, description, role_id, model_config, status, created_at, updated_at`,
            [
              req.body.name,
              req.body.description ?? "",
              roleId,
              JSON.stringify(req.body.modelConfig ?? {}),
            ],
          );
          const created = rows[0]!;
          await recordEvent(client, {
            eventType: "agent.created",
            actor: actorOf(req),
            entityType: "agent",
            entityId: created.id as string,
            payload: { name: req.body.name, roleId },
          });
          return created;
        });
        return reply.status(201).send({ agent });
      } catch (err) {
        if (pgErrorCode(err) === "23505") {
          return reply.status(409).send({ error: `agent "${req.body.name}" already exists` });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: IdParamsT; Body: Static<typeof UpdateAgentBody> }>(
    "/agents/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        operationId: "updateAgent",
        tags: ["agents"],
        params: IdParams,
        body: UpdateAgentBody,
      },
    },
    async (req, reply) => {
      const changes = req.body;
      if (
        changes.description === undefined &&
        changes.modelConfig === undefined &&
        changes.roleId === undefined
      ) {
        return reply.status(400).send({ error: "no fields to update" });
      }
      if (changes.roleId !== undefined) {
        const role = await pool.query("SELECT 1 FROM roles WHERE id = $1", [changes.roleId]);
        if (role.rows.length === 0) return reply.status(404).send({ error: "role not found" });
      }
      const agent = await inTx(pool, async (client) => {
        const { rows } = await client.query(
          `UPDATE agents SET
             description = coalesce($2, description),
             model_config = coalesce($3, model_config),
             role_id = coalesce($4, role_id),
             updated_at = now()
           WHERE id = $1
           RETURNING id, name, description, role_id, model_config, status, created_at, updated_at`,
          [
            req.params.id,
            changes.description ?? null,
            changes.modelConfig !== undefined ? JSON.stringify(changes.modelConfig) : null,
            changes.roleId ?? null,
          ],
        );
        if (!rows[0]) return null;
        await recordEvent(client, {
          eventType: "agent.updated",
          actor: actorOf(req),
          entityType: "agent",
          entityId: req.params.id,
          payload: { changes: changes as Record<string, unknown> },
        });
        return rows[0];
      });
      if (!agent) return reply.status(404).send({ error: "agent not found" });
      return { agent };
    },
  );

  app.post<{ Params: IdParamsT; Body: Static<typeof AgentStatusBody> }>(
    "/agents/:id/status",
    {
      preHandler: [requireAdmin],
      schema: {
        operationId: "setAgentStatus",
        tags: ["agents"],
        params: IdParams,
        body: AgentStatusBody,
      },
    },
    async (req, reply) => {
      const agent = await inTx(pool, async (client) => {
        const prev = await client.query<{ status: string }>(
          "SELECT status FROM agents WHERE id = $1 FOR UPDATE",
          [req.params.id],
        );
        if (!prev.rows[0]) return null;
        const { rows } = await client.query(
          `UPDATE agents SET status = $2, updated_at = now()
            WHERE id = $1
            RETURNING id, name, description, role_id, model_config, status, created_at, updated_at`,
          [req.params.id, req.body.status],
        );
        await recordEvent(client, {
          eventType: "agent.status_changed",
          actor: actorOf(req),
          entityType: "agent",
          entityId: req.params.id,
          payload: { from: prev.rows[0].status, to: req.body.status },
        });
        return rows[0]!;
      });
      if (!agent) return reply.status(404).send({ error: "agent not found" });
      return { agent };
    },
  );

  app.get(
    "/agents",
    { schema: { operationId: "listAgents", tags: ["agents"] } },
    async () => {
      const { rows } = await pool.query(
        `SELECT a.id, a.name, a.description, a.status, a.model_config,
                a.created_at, a.updated_at, r.id AS role_id, r.name AS role
           FROM agents a
           JOIN roles r ON r.id = a.role_id
          ORDER BY a.name`,
      );
      return { agents: rows };
    },
  );

  app.get<{ Params: IdParamsT }>(
    "/agents/:id",
    { schema: { operationId: "getAgent", tags: ["agents"], params: IdParams } },
    async (req, reply) => {
      const agent = await pool.query(
        `SELECT a.id, a.name, a.description, a.status, a.model_config,
                a.created_at, a.updated_at, r.id AS role_id, r.name AS role
           FROM agents a
           JOIN roles r ON r.id = a.role_id
          WHERE a.id = $1`,
        [req.params.id],
      );
      if (!agent.rows[0]) return reply.status(404).send({ error: "agent not found" });
      const skills = await pool.query(
        `SELECT s.id, s.name, s.version, s.risk_tier, s.status, g.created_at AS granted_at
           FROM role_skill_grants g
           JOIN skills s ON s.id = g.skill_id
          WHERE g.role_id = $1 AND g.revoked_at IS NULL
          ORDER BY s.name, s.version`,
        [agent.rows[0].role_id],
      );
      // recentRuns is run-INSTANCE data (ids/status/timing of runs this agent
      // executed). Runs are object-scoped elsewhere (the /runs list + canReadRun),
      // and agent-triggered runs have no user owner so they are admin-visibility.
      // Exposing them on this open registry-detail route would let any non-admin
      // enumerate other actors' run activity, so it is privileged-only here.
      const privileged = authDisabled() || req.authUser?.is_admin === true;
      const runs = privileged
        ? await pool.query(
            `SELECT DISTINCT fr.id, fr.status, fr.created_at, fr.finished_at
               FROM flow_runs fr
               JOIN step_runs sr ON sr.run_id = fr.id
              WHERE sr.agent_id = $1
              ORDER BY fr.created_at DESC
              LIMIT 10`,
            [req.params.id],
          )
        : { rows: [] };
      return { agent: agent.rows[0], skills: skills.rows, recentRuns: runs.rows };
    },
  );

  // ----------------------------------------------------------------- flows

  app.post<{ Body: Static<typeof PublishFlowBody> }>(
    "/flows",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "publishFlow", tags: ["flows"], body: PublishFlowBody },
    },
    async (req, reply) => {
      try {
        const published = await publishFlowVersion(pool, {
          definition: req.body.definition,
          actor: actorOf(req),
          ...(req.authUser ? { createdByUserId: req.authUser.id } : {}),
        });
        return reply.status(201).send({
          flowId: published.flowId,
          flowVersionId: published.flowVersionId,
          version: published.version,
        });
      } catch (err) {
        if (err instanceof FlowValidationError) {
          return reply
            .status(400)
            .send({ error: "invalid flow definition", details: err.errors });
        }
        throw err;
      }
    },
  );

  app.get(
    "/flows",
    { schema: { operationId: "listFlows", tags: ["flows"] } },
    async () => {
      const { rows } = await pool.query(
        `SELECT f.id, f.name, f.created_at,
                max(fv.version)::int AS latest_version,
                (SELECT status FROM flow_versions
                  WHERE flow_id = f.id ORDER BY version DESC LIMIT 1) AS latest_status
           FROM flows f
           LEFT JOIN flow_versions fv ON fv.flow_id = f.id
          GROUP BY f.id
          ORDER BY f.name`,
      );
      return { flows: rows };
    },
  );

  app.get<{ Params: { name: string } }>(
    "/flows/:name",
    { schema: { operationId: "getFlow", tags: ["flows"] } },
    async (req, reply) => {
      const flow = await pool.query("SELECT id, name, created_at FROM flows WHERE name = $1", [
        req.params.name,
      ]);
      if (!flow.rows[0]) return reply.status(404).send({ error: "flow not found" });
      const versions = await pool.query(
        `SELECT id, version, status, definition, created_at
           FROM flow_versions WHERE flow_id = $1 ORDER BY version DESC`,
        [flow.rows[0].id],
      );
      // A gate's approver_emails are named human identities (PII). Admins (and
      // auth-disabled mode) get the full definition; every other caller gets it
      // with that list stripped from each gate. Read-path shaping only — the
      // stored definition and all enforcement paths keep the full list.
      const privileged = authDisabled() || req.authUser?.is_admin === true;
      const rows = privileged
        ? versions.rows
        : versions.rows.map((v: Record<string, unknown>) => ({
            ...v,
            definition: maskApproverEmails(v.definition),
          }));
      return { flow: flow.rows[0], versions: rows };
    },
  );

  // -------------------------------------------------------------- triggers

  app.post<{ Body: Static<typeof CreateTriggerBody> }>(
    "/triggers",
    {
      preHandler: [requireAdmin],
      schema: { operationId: "createTrigger", tags: ["triggers"], body: CreateTriggerBody },
    },
    async (req, reply) => {
      const flow = await pool.query<{ id: string }>("SELECT id FROM flows WHERE name = $1", [
        req.body.flowName,
      ]);
      if (!flow.rows[0]) return reply.status(404).send({ error: "flow not found" });
      const trigger = await inTx(pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO flow_triggers (flow_id, type, config)
           VALUES ($1, $2, $3)
           RETURNING id, flow_id, type, config, enabled, created_at`,
          [flow.rows[0]!.id, req.body.type, JSON.stringify(req.body.config ?? {})],
        );
        const created = rows[0]!;
        await recordEvent(client, {
          eventType: "trigger.created",
          actor: actorOf(req),
          entityType: "flow_trigger",
          entityId: created.id as string,
          payload: { flowName: req.body.flowName, type: req.body.type },
        });
        return created;
      });
      return reply.status(201).send({ trigger });
    },
  );

  app.patch<{ Params: IdParamsT; Body: Static<typeof UpdateTriggerBody> }>(
    "/triggers/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        operationId: "updateTrigger",
        tags: ["triggers"],
        params: IdParams,
        body: UpdateTriggerBody,
      },
    },
    async (req, reply) => {
      const trigger = await inTx(pool, async (client) => {
        const { rows } = await client.query(
          `UPDATE flow_triggers SET enabled = $2
            WHERE id = $1
            RETURNING id, flow_id, type, config, enabled, created_at`,
          [req.params.id, req.body.enabled],
        );
        if (!rows[0]) return null;
        await recordEvent(client, {
          eventType: "trigger.updated",
          actor: actorOf(req),
          entityType: "flow_trigger",
          entityId: req.params.id,
          payload: { enabled: req.body.enabled },
        });
        return rows[0];
      });
      if (!trigger) return reply.status(404).send({ error: "trigger not found" });
      return { trigger };
    },
  );

  app.get(
    "/triggers",
    { schema: { operationId: "listTriggers", tags: ["triggers"] } },
    async () => {
      const { rows } = await pool.query(
        `SELECT t.id, t.type, t.config, t.enabled, t.created_at, f.name AS flow
           FROM flow_triggers t
           JOIN flows f ON f.id = t.flow_id
          ORDER BY t.created_at`,
      );
      return { triggers: rows };
    },
  );

  // ----------------------------------------------------- webhook endpoints

  app.post<{ Body: Static<typeof CreateWebhookEndpointBody> }>(
    "/webhook-endpoints",
    {
      preHandler: [requireAdmin],
      schema: {
        operationId: "createWebhookEndpoint",
        tags: ["webhooks"],
        body: CreateWebhookEndpointBody,
      },
    },
    async (req, reply) => {
      const endpoint = await inTx(pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO webhook_endpoints (url, secret, enabled)
           VALUES ($1, $2, $3)
           RETURNING id, url, enabled, created_at`,
          [req.body.url, req.body.secret, req.body.enabled ?? true],
        );
        const created = rows[0]!;
        // The secret is deliberately excluded from the audit payload.
        await recordEvent(client, {
          eventType: "webhook_endpoint.created",
          actor: actorOf(req),
          entityType: "webhook_endpoint",
          entityId: created.id as string,
          payload: { url: req.body.url, enabled: req.body.enabled ?? true },
        });
        return created;
      });
      return reply.status(201).send({ webhookEndpoint: endpoint });
    },
  );

  app.get(
    "/webhook-endpoints",
    { schema: { operationId: "listWebhookEndpoints", tags: ["webhooks"] } },
    async () => {
      // Secrets are write-only: never returned after creation.
      const { rows } = await pool.query(
        "SELECT id, url, enabled, created_at FROM webhook_endpoints ORDER BY created_at",
      );
      return { webhookEndpoints: rows };
    },
  );
}
