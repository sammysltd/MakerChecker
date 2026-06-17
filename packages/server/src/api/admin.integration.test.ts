import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { buildApp } from "../app.js";
import { authenticateApiKey, generateApiKey, type GeneratedApiKey } from "../auth/api-keys.js";
import { GraphileWorkerBackend } from "../engine/graphile-backend.js";
import { LocalSkillExecutor } from "../engine/executor.js";
import type { EngineContext } from "../engine/orchestrator.js";

let db: TestDb;
let ctx: EngineContext;
let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
let key: GeneratedApiKey;
let auth: Record<string, string>;

beforeAll(async () => {
  db = await createTestDb();
  const user = await db.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, is_admin)
     VALUES ('ops@test.local', 'x', 'Ops Admin', true) RETURNING id`,
  );
  userId = user.rows[0]!.id;
  key = await generateApiKey(db.pool, { userId, name: "test-key" });
  auth = { authorization: `Bearer ${key.plaintext}` };

  // The backend is never started: admin routes must not need the engine.
  ctx = {
    pool: db.pool,
    backend: new GraphileWorkerBackend(db.pool, 1),
    executor: new LocalSkillExecutor(new Map()),
  };
  app = await buildApp(ctx);
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.drop();
});

async function auditEvent(
  eventType: string,
  entityId: string,
): Promise<{ actor: Record<string, unknown>; payload: Record<string, unknown> } | undefined> {
  const { rows } = await db.pool.query<{
    actor: Record<string, unknown>;
    payload: Record<string, unknown>;
  }>("SELECT actor, payload FROM audit_events WHERE event_type = $1 AND entity_id = $2", [
    eventType,
    entityId,
  ]);
  return rows[0];
}

describe("API-key generation and verification", () => {
  it("generates mk_<32 hex> keys, stores only hash + prefix, audits creation", async () => {
    expect(key.plaintext).toMatch(/^mk_[0-9a-f]{32}$/);
    expect(key.keyPrefix).toBe(key.plaintext.slice(0, 8));
    const { rows } = await db.pool.query(
      "SELECT key_prefix, key_hash FROM api_keys WHERE id = $1",
      [key.id],
    );
    expect(rows[0].key_prefix).toBe(key.keyPrefix);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].key_hash).not.toContain(key.plaintext);
    const event = await auditEvent("api_key.created", key.id);
    expect(event?.payload).toMatchObject({ keyPrefix: key.keyPrefix, name: "test-key" });
    // The plaintext must never reach the audit log.
    expect(JSON.stringify(event)).not.toContain(key.plaintext);
  });

  it("authenticates a valid key and rejects malformed or unknown ones", async () => {
    const user = await authenticateApiKey(db.pool, key.plaintext);
    expect(user).toMatchObject({ id: userId, email: "ops@test.local", is_admin: true });
    expect(await authenticateApiKey(db.pool, "not-a-key")).toBeNull();
    expect(await authenticateApiKey(db.pool, `mk_${"0".repeat(32)}`)).toBeNull();
  });
});

describe("auth hook", () => {
  it("401s requests without a key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/roles" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("missing API key");
  });

  it("401s a non-Bearer authorization header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/roles",
      headers: { authorization: `Basic ${key.plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("401s an unknown key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/roles",
      headers: { authorization: `Bearer mk_${"f".repeat(32)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("invalid or revoked");
  });

  it("admits a valid key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/roles", headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a revoked key", async () => {
    const revoked = await generateApiKey(db.pool, { userId, name: "soon-revoked" });
    const before = await app.inject({
      method: "GET",
      url: "/api/roles",
      headers: { authorization: `Bearer ${revoked.plaintext}` },
    });
    expect(before.statusCode).toBe(200);
    await db.pool.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [revoked.id]);
    const after = await app.inject({
      method: "GET",
      url: "/api/roles",
      headers: { authorization: `Bearer ${revoked.plaintext}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("leaves /healthz open", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("leaves /readyz open and ready against a live DB", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", schemaVersion: 1 });
  });

  it("skips auth entirely in MAKERCHECKER_AUTH_DISABLED=1 mode; actor falls back to 'api'", async () => {
    process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/roles",
        payload: { name: "noauth-role" },
      });
      expect(res.statusCode).toBe(201);
      const event = await auditEvent("role.created", res.json().role.id);
      expect(event?.actor).toMatchObject({ type: "user", name: "api" });
    } finally {
      delete process.env.MAKERCHECKER_AUTH_DISABLED;
    }
  });
});

describe("roles", () => {
  let roleId: string;

  it("creates a role and audits it with the authenticated actor", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth,
      payload: {
        name: "payments-ops",
        description: "Operates payments",
        limits: { run: { maxSkillInvocations: 5 } },
      },
    });
    expect(res.statusCode).toBe(201);
    roleId = res.json().role.id;
    expect(res.json().role).toMatchObject({
      name: "payments-ops",
      limits: { run: { maxSkillInvocations: 5 } },
    });
    const event = await auditEvent("role.created", roleId);
    expect(event?.actor).toMatchObject({ type: "user", id: userId, name: "ops@test.local" });
  });

  it("409s a duplicate role name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth,
      payload: { name: "payments-ops" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("400s an invalid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth,
      payload: { description: "no name" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("name");
  });

  it("saves a fully-formed limits object (every field) verbatim", async () => {
    // Exercises both run-level budgets and a per-skill ceiling with a custom
    // amount field: the complete RoleLimits surface that engine/limits.ts reads.
    const limits = {
      run: { maxSkillInvocations: 10, maxTokens: 50000 },
      skills: {
        "post-payment@1": {
          maxInvocationsPerRun: 3,
          maxAmountPerInvocation: 1000.5,
          amountField: "amount_cents",
        },
        "notify@2": { maxInvocationsPerRun: 0 },
      },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth,
      payload: { name: "full-limits-role", limits },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role.limits).toEqual(limits);
  });

  it("saves per-skill allowlist + pathScope argument grants verbatim", async () => {
    // The argument-level grant policy (engine/limits.ts assertSkillLimits): a
    // destination allowlist and a path scope, persisted exactly as written so the
    // runtime fail-closed checks enforce the operator's intent, not a coerced
    // approximation of it.
    const limits = {
      skills: {
        "transfer@1": {
          maxAmountPerInvocation: 5000,
          amountField: "amount",
          allowlist: { field: "destination", values: ["0xSAFE", "0xTREASURY"] },
          pathScope: { field: "path", prefix: "/workspace/project" },
        },
      },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth,
      payload: { name: "arg-grant-role", limits },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role.limits).toEqual(limits);
    // Round-trips on read-back too: the saved row equals what was written.
    const back = await app.inject({
      method: "GET",
      url: `/api/roles/${res.json().role.id}`,
      headers: auth,
    });
    expect(back.json().role.limits).toEqual(limits);
  });

  it("400s every malformed allowlist/pathScope shape before save", async () => {
    // Argument-grant analogue of the malformed-limits gate above: each case is an
    // allowlist or pathScope that the runtime would either deny silently at
    // runtime or (worse) coerce into a bogus grant. Validation must reject all of
    // them with a 400 BEFORE the row is written. Heavy/adversarial coverage of the
    // new SkillLimitConfig predicates and the absolute-prefix pattern.
    const sk = (cfg: unknown) => ({ skills: { "pay@1": cfg } });
    const malformed: Array<[string, unknown]> = [
      // allowlist.values must be a non-empty array of strings (minItems: 1).
      ["allowlist.values is empty []", sk({ allowlist: { field: "destination", values: [] } })],
      [
        "allowlist.values has a non-string item [1]",
        sk({ allowlist: { field: "destination", values: [1] } }),
      ],
      [
        "allowlist.values mixes a non-string item ['ok', 2]",
        sk({ allowlist: { field: "destination", values: ["ok", 2] } }),
      ],
      [
        "allowlist.values has an empty-string item",
        sk({ allowlist: { field: "destination", values: [""] } }),
      ],
      // values supplied as a single string: the strict (coercion-off) gate must
      // reject it, never wrap a scalar into a one-element array.
      [
        "allowlist.values is a single string (must not coerce to array)",
        sk({ allowlist: { field: "destination", values: "0xSAFE" } }),
      ],
      // allowlist.field is required and non-empty.
      ["allowlist missing field", sk({ allowlist: { values: ["0xSAFE"] } })],
      [
        "allowlist.field is empty",
        sk({ allowlist: { field: "", values: ["0xSAFE"] } }),
      ],
      // unknown nested key under allowlist (additionalProperties: false).
      [
        "allowlist has an unknown nested key",
        sk({ allowlist: { field: "destination", values: ["0xSAFE"], extra: 1 } }),
      ],
      // pathScope.prefix is required, non-empty, absolute, and traversal-free.
      ["pathScope.prefix is empty", sk({ pathScope: { field: "path", prefix: "" } })],
      ["pathScope missing prefix", sk({ pathScope: { field: "path" } })],
      [
        "pathScope.prefix is relative ('..')",
        sk({ pathScope: { field: "path", prefix: ".." } }),
      ],
      [
        "pathScope.prefix is relative ('../shared')",
        sk({ pathScope: { field: "path", prefix: "../shared" } }),
      ],
      [
        "pathScope.prefix is relative ('data')",
        sk({ pathScope: { field: "path", prefix: "data" } }),
      ],
      [
        "pathScope.prefix has a traversal segment ('/app/../x')",
        sk({ pathScope: { field: "path", prefix: "/app/../x" } }),
      ],
      // pathScope.field must be a non-empty string.
      [
        "pathScope.field is a number",
        sk({ pathScope: { field: 7, prefix: "/workspace" } }),
      ],
      ["pathScope.field is empty", sk({ pathScope: { field: "", prefix: "/workspace" } })],
      // unknown nested key under pathScope (additionalProperties: false).
      [
        "pathScope has an unknown nested key",
        sk({ pathScope: { field: "path", prefix: "/workspace", extra: 1 } }),
      ],
      // wrong type for the whole predicate: allowlist/pathScope must be objects.
      ["allowlist is a string", sk({ allowlist: "0xSAFE" })],
      ["allowlist is an array", sk({ allowlist: ["0xSAFE"] })],
      ["pathScope is a string", sk({ pathScope: "/workspace" })],
      ["pathScope is an array", sk({ pathScope: ["/workspace"] })],
    ];
    for (const [label, limits] of malformed) {
      const res = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: auth,
        payload: { name: `argbad-${label.replace(/[^a-z0-9]+/gi, "-")}`, limits },
      });
      expect(res.statusCode, `${label} should be rejected 400`).toBe(400);
    }
    // None of the rejected roles were written.
    const list = await app.inject({ method: "GET", url: "/api/roles", headers: auth });
    expect(list.json().roles.some((r: { name: string }) => r.name.startsWith("argbad-"))).toBe(
      false,
    );
  });

  it("accepts a config built from every SkillLimitConfig field (lockstep guard)", async () => {
    // The route schema must stay in lockstep with the SkillLimitConfig TS type in
    // engine/limits.ts: a config that names EVERY field must pass the write schema.
    // If a TS field were added without the matching TypeBox field, this object
    // would carry an unknown key and be rejected by additionalProperties: false,
    // failing this test — the alarm that keeps schema and type in sync.
    const everyField = {
      maxInvocationsPerRun: 3,
      maxAmountPerInvocation: 1000,
      amountField: "amount_cents",
      allowlist: { field: "destination", values: ["0xSAFE", "0xTREASURY"] },
      pathScope: { field: "path", prefix: "/workspace/project" },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth,
      payload: { name: "lockstep-role", limits: { skills: { "pay@1": everyField } } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role.limits.skills["pay@1"]).toEqual(everyField);
  });

  it("saves a role with no limits (defaults to {})", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth,
      payload: { name: "no-limits-role" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role.limits).toEqual({});
  });

  it("400s every malformed limits shape before save (validate at write time)", async () => {
    // Each case is a limits object that the runtime fail-closed checks would
    // either silently never enforce or only deny at runtime. Validation must
    // reject all of them with a 400 BEFORE the row is written, so no malformed
    // ceiling is ever persisted. Heavy/adversarial coverage of the schema.
    const malformed: Array<[string, unknown]> = [
      // wrong type: limits is not an object
      ["limits is a string", "lots"],
      ["limits is an array", []],
      // wrong type: a budget value is a string, not a number. Fastify's default
      // coerceTypes would silently turn "5" into 5; the strict preValidation
      // gate must reject it on the RAW body before coercion.
      ["run.maxSkillInvocations is a string", { run: { maxSkillInvocations: "5" } }],
      ["run.maxTokens is a string", { run: { maxTokens: "1000" } }],
      // coercion footguns: each of these would coerce to a "valid" number and
      // silently install a bogus ceiling (true->1, null->0 = deny everything,
      // [5]->5). The strict gate rejects all of them.
      ["run.maxSkillInvocations is a boolean", { run: { maxSkillInvocations: true } }],
      ["run.maxSkillInvocations is null (would coerce to 0)", { run: { maxSkillInvocations: null } }],
      ["run.maxSkillInvocations is an array", { run: { maxSkillInvocations: [5] } }],
      ["skills.maxInvocationsPerRun is null", { skills: { "pay@1": { maxInvocationsPerRun: null } } }],
      // amountField as a number would coerce to a string and silently retarget
      // which input field the amount ceiling reads.
      ["skills.amountField is a number (would coerce to string)", { skills: { "pay@1": { amountField: 7 } } }],
      // wrong type: maxInvocationsPerRun is not an integer
      [
        "skills.maxInvocationsPerRun is a float",
        { skills: { "pay@1": { maxInvocationsPerRun: 2.5 } } },
      ],
      [
        "skills.maxInvocationsPerRun is a string",
        { skills: { "pay@1": { maxInvocationsPerRun: "2" } } },
      ],
      // wrong type: maxAmountPerInvocation is a string
      [
        "skills.maxAmountPerInvocation is a string",
        { skills: { "pay@1": { maxAmountPerInvocation: "1000" } } },
      ],
      // empty amountField would silently fall through to "amount" or worse
      ["skills.amountField is empty", { skills: { "pay@1": { amountField: "" } } }],
      // negative ceilings: a negative budget can never enforce a real cap
      ["run.maxSkillInvocations is negative", { run: { maxSkillInvocations: -1 } }],
      ["run.maxTokens is negative", { run: { maxTokens: -100 } }],
      [
        "skills.maxInvocationsPerRun is negative",
        { skills: { "pay@1": { maxInvocationsPerRun: -1 } } },
      ],
      [
        "skills.maxAmountPerInvocation is negative",
        { skills: { "pay@1": { maxAmountPerInvocation: -0.01 } } },
      ],
      // unknown nested keys: a typo'd ceiling silently governs nothing
      ["unknown top-level key", { runn: { maxSkillInvocations: 5 } }],
      ["unknown run key (typo'd maxInvocations)", { run: { maxInvocations: 5 } }],
      [
        "unknown skill-config key (typo'd maxInvocationsPerRun)",
        { skills: { "pay@1": { maxInvocations: 5 } } },
      ],
      // mis-targeted ceiling: the skills key is not a valid skillRef, so it can
      // never match a runtime skillRef and is dead config
      ["skills key missing @version", { skills: { pay: { maxInvocationsPerRun: 1 } } }],
      ["skills key has non-numeric version", { skills: { "pay@v1": { maxInvocationsPerRun: 1 } } }],
      [
        "skills key has uppercase name",
        { skills: { "Pay@1": { maxInvocationsPerRun: 1 } } },
      ],
      // leading-zero / zero versions are non-canonical: they resolve to a
      // different string at runtime (pay@1) so the limit would never apply.
      ["skills key has a leading-zero version", { skills: { "pay@01": { maxInvocationsPerRun: 1 } } }],
      ["skills key has version 0", { skills: { "pay@0": { maxInvocationsPerRun: 1 } } }],
    ];
    for (const [label, limits] of malformed) {
      const res = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: auth,
        payload: { name: `bad-${label.replace(/[^a-z0-9]+/gi, "-")}`, limits },
      });
      expect(res.statusCode, `${label} should be rejected 400`).toBe(400);
    }
    // None of the rejected roles were written.
    const list = await app.inject({ method: "GET", url: "/api/roles", headers: auth });
    expect(list.json().roles.some((r: { name: string }) => r.name.startsWith("bad-"))).toBe(false);
  });

  it("lists roles with active grant counts", async () => {
    const res = await app.inject({ method: "GET", url: "/api/roles", headers: auth });
    const role = res.json().roles.find((r: { name: string }) => r.name === "payments-ops");
    expect(role.active_grant_count).toBe(0);
  });

  it("gets a role with grants and SoD constraints; 404s unknown; 400s bad uuid", async () => {
    const res = await app.inject({ method: "GET", url: `/api/roles/${roleId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ grants: [], sodConstraints: [] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/roles/00000000-0000-0000-0000-000000000000",
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api/roles/not-a-uuid", headers: auth })).statusCode,
    ).toBe(400);
  });

  it("405s DELETE — roles are forever", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/roles/${roleId}`, headers: auth });
    expect(res.statusCode).toBe(405);
  });
});

describe("SoD constraints", () => {
  let roleA: string;
  let roleB: string;
  let constraintId: string;

  beforeAll(async () => {
    for (const name of ["sod-maker", "sod-checker"]) {
      await app.inject({ method: "POST", url: "/api/roles", headers: auth, payload: { name } });
    }
    const res = await app.inject({ method: "GET", url: "/api/roles", headers: auth });
    const roles = res.json().roles as Array<{ id: string; name: string }>;
    roleA = roles.find((r) => r.name === "sod-maker")!.id;
    roleB = roles.find((r) => r.name === "sod-checker")!.id;
  });

  it("creates a constraint with canonical least/greatest ordering", async () => {
    // Deliberately pass the pair in descending order; storage must canonicalize.
    const [hi, lo] = roleA > roleB ? [roleA, roleB] : [roleB, roleA];
    const res = await app.inject({
      method: "POST",
      url: "/api/sod-constraints",
      headers: auth,
      payload: { roleAId: hi, roleBId: lo, description: "maker-checker" },
    });
    expect(res.statusCode).toBe(201);
    const sc = res.json().sodConstraint;
    constraintId = sc.id;
    expect(sc.role_a_id < sc.role_b_id).toBe(true);
    expect(await auditEvent("sod_constraint.created", constraintId)).toBeDefined();
  });

  it("400s a self-pair", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sod-constraints",
      headers: auth,
      payload: { roleAId: roleA, roleBId: roleA },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s unknown roles", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sod-constraints",
      headers: auth,
      payload: { roleAId: roleA, roleBId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("appears on the role detail", async () => {
    const res = await app.inject({ method: "GET", url: `/api/roles/${roleA}`, headers: auth });
    expect(res.json().sodConstraints).toHaveLength(1);
  });

  it("revokes once (audited), then 409s; 404s unknown ids", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sod-constraints/${constraintId}/revoke`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sodConstraint.revoked_at).not.toBeNull();
    expect(await auditEvent("sod_constraint.revoked", constraintId)).toBeDefined();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/sod-constraints/${constraintId}/revoke`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/sod-constraints/00000000-0000-0000-0000-000000000000/revoke",
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("skills", () => {
  let skillId: string;

  it("publishes an immutable skill (audited)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth,
      payload: {
        name: "wire-transfer",
        version: 1,
        description: "Sends a wire",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        implementation: { type: "local" },
        riskTier: "high",
      },
    });
    expect(res.statusCode).toBe(201);
    skillId = res.json().skill.id;
    expect(res.json().skill.status).toBe("published");
    const event = await auditEvent("skill.published", skillId);
    expect(event?.payload).toMatchObject({ name: "wire-transfer", version: 1, riskTier: "high" });
  });

  it("409s a duplicate name@version and 400s a bad riskTier", async () => {
    const dup = await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth,
      payload: {
        name: "wire-transfer",
        version: 1,
        description: "again",
        inputSchema: {},
        outputSchema: {},
        implementation: { type: "local" },
        riskTier: "low",
      },
    });
    expect(dup.statusCode).toBe(409);
    const bad = await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth,
      payload: {
        name: "wire-transfer",
        version: 2,
        description: "x",
        inputSchema: {},
        outputSchema: {},
        implementation: {},
        riskTier: "extreme",
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("lists the registry including status, gets one with grant history", async () => {
    const list = await app.inject({ method: "GET", url: "/api/skills", headers: auth });
    expect(
      list.json().skills.find((s: { name: string }) => s.name === "wire-transfer"),
    ).toMatchObject({ version: 1, status: "published" });
    const one = await app.inject({ method: "GET", url: `/api/skills/${skillId}`, headers: auth });
    expect(one.json().skill.name).toBe("wire-transfer");
    expect(one.json().grantHistory).toEqual([]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/skills/00000000-0000-0000-0000-000000000000",
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("405s PATCH attempts — published skills are immutable", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/skills/${skillId}`,
      headers: auth,
      payload: { description: "edited" },
    });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toContain("immutable");
  });

  it("deprecates once (audited), then 409s; 404s unknown", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/${skillId}/deprecate`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().skill.status).toBe("deprecated");
    expect(await auditEvent("skill.deprecated", skillId)).toBeDefined();
    expect(
      (
        await app.inject({ method: "POST", url: `/api/skills/${skillId}/deprecate`, headers: auth })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/skills/00000000-0000-0000-0000-000000000000/deprecate",
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("grants", () => {
  let roleId: string;
  let skillId: string;
  let grantId: string;

  beforeAll(async () => {
    const role = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth,
      payload: { name: "grant-role" },
    });
    roleId = role.json().role.id;
    const skill = await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth,
      payload: {
        name: "grantable",
        version: 1,
        description: "d",
        inputSchema: {},
        outputSchema: {},
        implementation: { type: "local" },
        riskTier: "low",
      },
    });
    skillId = skill.json().skill.id;
  });

  it("creates a grant (audited), 409s an identical active grant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: auth,
      payload: { roleId, skillId },
    });
    expect(res.statusCode).toBe(201);
    grantId = res.json().grant.id;
    const event = await auditEvent("grant.created", grantId);
    expect(event?.payload).toMatchObject({ skill: "grantable@1" });

    const dup = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: auth,
      payload: { roleId, skillId },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().grantId).toBe(grantId);
  });

  it("404s grants against unknown roles or skills", async () => {
    const zero = "00000000-0000-0000-0000-000000000000";
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/grants",
          headers: auth,
          payload: { roleId: zero, skillId },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/grants",
          headers: auth,
          payload: { roleId, skillId: zero },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("shows up in role detail and grant counts", async () => {
    const role = await app.inject({ method: "GET", url: `/api/roles/${roleId}`, headers: auth });
    expect(role.json().grants).toHaveLength(1);
    const list = await app.inject({ method: "GET", url: "/api/roles", headers: auth });
    expect(
      list.json().roles.find((r: { id: string }) => r.id === roleId).active_grant_count,
    ).toBe(1);
  });

  it("revokes (audited), allows re-granting, 409s double revoke, 404s unknown", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/grants/${grantId}/revoke`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().grant.revoked_at).not.toBeNull();
    expect(await auditEvent("grant.revoked", grantId)).toBeDefined();

    expect(
      (
        await app.inject({ method: "POST", url: `/api/grants/${grantId}/revoke`, headers: auth })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/grants/00000000-0000-0000-0000-000000000000/revoke",
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);

    // Revocation is not a tombstone: the same pair can be granted again.
    const again = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: auth,
      payload: { roleId, skillId },
    });
    expect(again.statusCode).toBe(201);

    // Grant history on the skill shows both grants, who granted, who revoked.
    const skill = await app.inject({ method: "GET", url: `/api/skills/${skillId}`, headers: auth });
    const history = skill.json().grantHistory;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      role: "grant-role",
      granted_by: "ops@test.local",
      revoked_by: "ops@test.local",
    });
    expect(history[1].revoked_at).toBeNull();
  });
});

describe("agents", () => {
  let agentId: string;
  let roleId: string;

  beforeAll(async () => {
    const res = await app.inject({ method: "GET", url: "/api/roles", headers: auth });
    roleId = res.json().roles.find((r: { name: string }) => r.name === "grant-role").id;
  });

  it("creates an agent by roleName (audited)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: auth,
      payload: { name: "payments-bot", roleName: "grant-role", modelConfig: { model: "m1" } },
    });
    expect(res.statusCode).toBe(201);
    agentId = res.json().agent.id;
    expect(res.json().agent).toMatchObject({ status: "active", role_id: roleId });
    expect(await auditEvent("agent.created", agentId)).toBeDefined();
  });

  it("creates an agent by roleId; 400s with neither; 404s unknown roles; 409s duplicates", async () => {
    const byId = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: auth,
      payload: { name: "second-bot", roleId },
    });
    expect(byId.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agents",
          headers: auth,
          payload: { name: "role-less" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agents",
          headers: auth,
          payload: { name: "ghost", roleName: "no-such-role" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agents",
          headers: auth,
          payload: { name: "payments-bot", roleId },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("updates description/modelConfig/role (audited); rejects empty patches; 404s", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: auth,
      payload: { description: "moves money", modelConfig: { model: "m2" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toMatchObject({
      description: "moves money",
      model_config: { model: "m2" },
    });
    expect(await auditEvent("agent.updated", agentId)).toBeDefined();

    expect(
      (
        await app.inject({ method: "PATCH", url: `/api/agents/${agentId}`, headers: auth, payload: {} })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/agents/${agentId}`,
          headers: auth,
          payload: { roleId: "00000000-0000-0000-0000-000000000000" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/agents/00000000-0000-0000-0000-000000000000",
          headers: auth,
          payload: { description: "x" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("changes status with a from/to audit trail; validates status; 404s", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/status`,
      headers: auth,
      payload: { status: "suspended" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.status).toBe("suspended");
    const event = await auditEvent("agent.status_changed", agentId);
    expect(event?.payload).toEqual({ from: "active", to: "suspended" });

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/agents/${agentId}/status`,
          headers: auth,
          payload: { status: "fired" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agents/00000000-0000-0000-0000-000000000000/status",
          headers: auth,
          payload: { status: "active" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("lists agents with role names; gets one with granted skills and recent runs", async () => {
    const list = await app.inject({ method: "GET", url: "/api/agents", headers: auth });
    expect(
      list.json().agents.find((a: { id: string }) => a.id === agentId),
    ).toMatchObject({ role: "grant-role" });

    const one = await app.inject({ method: "GET", url: `/api/agents/${agentId}`, headers: auth });
    expect(one.statusCode).toBe(200);
    expect(one.json().skills).toEqual([
      expect.objectContaining({ name: "grantable", version: 1 }),
    ]);
    expect(one.json().recentRuns).toEqual([]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/agents/00000000-0000-0000-0000-000000000000",
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("flows and triggers", () => {
  let triggerId: string;

  it("publishes a flow via the API with the authenticated actor", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows",
      headers: auth,
      payload: {
        definition: {
          name: "admin-test-flow",
          steps: [{ key: "s1", agent: "payments-bot", skills: ["grantable@1"] }],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(1);
    const event = await auditEvent("flow.published", res.json().flowVersionId);
    expect(event?.actor).toMatchObject({ id: userId, name: "ops@test.local" });
  });

  it("400s an invalid definition with details", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/flows",
      headers: auth,
      payload: { definition: { name: "bad flow name!", steps: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.length).toBeGreaterThan(0);
  });

  it("lists flows with their latest version and gets all versions by name", async () => {
    const list = await app.inject({ method: "GET", url: "/api/flows", headers: auth });
    expect(
      list.json().flows.find((f: { name: string }) => f.name === "admin-test-flow"),
    ).toMatchObject({ latest_version: 1, latest_status: "published" });

    const one = await app.inject({ method: "GET", url: "/api/flows/admin-test-flow", headers: auth });
    expect(one.json().versions).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: "/api/flows/no-such-flow", headers: auth })).statusCode,
    ).toBe(404);
  });

  it("creates a trigger (audited); 404s unknown flows; 400s bad types", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: auth,
      payload: { flowName: "admin-test-flow", type: "cron", config: { schedule: "0 7 * * *" } },
    });
    expect(res.statusCode).toBe(201);
    triggerId = res.json().trigger.id;
    expect(await auditEvent("trigger.created", triggerId)).toBeDefined();

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/triggers",
          headers: auth,
          payload: { flowName: "no-such-flow", type: "cron" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/triggers",
          headers: auth,
          payload: { flowName: "admin-test-flow", type: "webhook" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("toggles a trigger (audited), lists with flow names, 404s unknown", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/triggers/${triggerId}`,
      headers: auth,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().trigger.enabled).toBe(false);
    expect(await auditEvent("trigger.updated", triggerId)).toBeDefined();

    const list = await app.inject({ method: "GET", url: "/api/triggers", headers: auth });
    expect(list.json().triggers[0]).toMatchObject({ flow: "admin-test-flow", enabled: false });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/triggers/00000000-0000-0000-0000-000000000000",
          headers: auth,
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("webhook endpoints", () => {
  it("creates an endpoint (audited, secret never echoed) and lists without secrets", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook-endpoints",
      headers: auth,
      payload: { url: "https://hooks.test.local/mc", secret: "super-secret-value" },
    });
    expect(res.statusCode).toBe(201);
    const endpoint = res.json().webhookEndpoint;
    expect(endpoint.secret).toBeUndefined();
    const event = await auditEvent("webhook_endpoint.created", endpoint.id);
    expect(JSON.stringify(event)).not.toContain("super-secret-value");

    const list = await app.inject({ method: "GET", url: "/api/webhook-endpoints", headers: auth });
    expect(list.json().webhookEndpoints[0]).toMatchObject({
      url: "https://hooks.test.local/mc",
      enabled: true,
    });
    expect(JSON.stringify(list.json())).not.toContain("super-secret-value");
  });

  it("400s a too-short secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook-endpoints",
      headers: auth,
      payload: { url: "https://hooks.test.local/mc", secret: "short" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("OpenAPI document", () => {
  it("serves the spec at /api/openapi.json with operationIds and tags", async () => {
    const res = await app.inject({ method: "GET", url: "/api/openapi.json", headers: auth });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.info.title).toBe("MakerChecker API");
    expect(doc.paths["/api/roles"].post.operationId).toBe("createRole");
    expect(doc.paths["/api/skills"].get.tags).toContain("skills");
    expect(Object.keys(doc.paths).length).toBeGreaterThanOrEqual(20);
  });
});

describe("audit chain after all admin traffic", () => {
  it("still verifies end to end", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit/verify", headers: auth });
    expect(res.json().ok).toBe(true);
    expect(res.json().count).toBeGreaterThan(15);
  });
});
