import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { authenticateApiKey } from "./api-keys.js";
import { bootstrapAdmin, createUser, UserExistsError } from "./users.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

/** All audit rows touching one entity, oldest first. */
async function eventsFor(entityId: string) {
  const { rows } = await db.pool.query<{
    event_type: string;
    actor: { type: string; name?: string };
    entity_type: string | null;
    entity_id: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT event_type, actor, entity_type, entity_id, payload
       FROM audit_events WHERE entity_id = $1 ORDER BY seq ASC`,
    [entityId],
  );
  return rows;
}

describe("createUser", () => {
  it("inserts a non-admin user and records user.created in the same transaction", async () => {
    const user = await createUser(db.pool, {
      email: "analyst@example.com",
      displayName: "An Analyst",
    });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.isAdmin).toBe(false);

    const { rows } = await db.pool.query<{
      email: string;
      display_name: string;
      is_admin: boolean;
      password_hash: string;
    }>("SELECT email, display_name, is_admin, password_hash FROM users WHERE id = $1", [user.id]);
    expect(rows[0]).toMatchObject({
      email: "analyst@example.com",
      display_name: "An Analyst",
      is_admin: false,
    });
    // password_hash is a real scrypt hash, never a plaintext or empty string.
    expect(rows[0]!.password_hash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);

    const events = await eventsFor(user.id);
    const created = events.find((e) => e.event_type === "user.created");
    expect(created).toBeDefined();
    expect(created!.entity_type).toBe("user");
    expect(created!.actor.type).toBe("system");
    // The audit payload carries identity metadata only — never a secret.
    expect(created!.payload).toMatchObject({
      email: "analyst@example.com",
      displayName: "An Analyst",
      isAdmin: false,
    });
    expect(JSON.stringify(created!.payload)).not.toContain(rows[0]!.password_hash);
  });

  it("sets is_admin when --admin is requested", async () => {
    const user = await createUser(db.pool, {
      email: "admin-flag@example.com",
      displayName: "Admin Flagged",
      isAdmin: true,
    });
    expect(user.isAdmin).toBe(true);
    const { rows } = await db.pool.query<{ is_admin: boolean }>(
      "SELECT is_admin FROM users WHERE id = $1",
      [user.id],
    );
    expect(rows[0]!.is_admin).toBe(true);

    const created = (await eventsFor(user.id)).find((e) => e.event_type === "user.created");
    expect(created!.payload).toMatchObject({ isAdmin: true });
  });

  it("ADVERSARIAL: re-raises a non-duplicate database error rather than masking it", async () => {
    // A NUL byte in a text field is rejected by Postgres with a non-23505 code;
    // createUser must surface that error untranslated (not as UserExistsError)
    // and leave no partial row behind.
    const nulName = `bad${String.fromCharCode(0)}name`;
    await expect(
      createUser(db.pool, { email: "nul@example.com", displayName: nulName }),
    ).rejects.not.toBeInstanceOf(UserExistsError);
    const users = await db.pool.query("SELECT id FROM users WHERE email = $1", ["nul@example.com"]);
    expect(users.rows).toHaveLength(0);
  });

  it("ADVERSARIAL: rejects a duplicate email and writes no second user or audit row", async () => {
    const email = "dupe@example.com";
    const first = await createUser(db.pool, { email, displayName: "First" });

    await expect(createUser(db.pool, { email, displayName: "Second" })).rejects.toBeInstanceOf(
      UserExistsError,
    );

    // The failed insert rolled back: still exactly one user and one user.created.
    const users = await db.pool.query("SELECT id FROM users WHERE email = $1", [email]);
    expect(users.rows).toHaveLength(1);
    const created = (await eventsFor(first.id)).filter((e) => e.event_type === "user.created");
    expect(created).toHaveLength(1);
  });
});

describe("bootstrapAdmin", () => {
  it("creates an admin and a working API key, auditing both events", async () => {
    const { user, apiKey } = await bootstrapAdmin(db.pool, {
      email: "boss@example.com",
      displayName: "The Boss",
    });

    expect(user.isAdmin).toBe(true);
    expect(apiKey.plaintext).toMatch(/^mk_[0-9a-f]{32}$/);

    // The issued key resolves to the new admin via the real authenticator.
    const authed = await authenticateApiKey(db.pool, apiKey.plaintext);
    expect(authed).not.toBeNull();
    expect(authed!.id).toBe(user.id);
    expect(authed!.is_admin).toBe(true);

    const userEvents = await eventsFor(user.id);
    expect(userEvents.some((e) => e.event_type === "user.created")).toBe(true);
    const keyEvents = await eventsFor(apiKey.id);
    expect(keyEvents.some((e) => e.event_type === "api_key.created")).toBe(true);
  });

  it("ADVERSARIAL: a second bootstrap for the same email fails cleanly with no extra key", async () => {
    const email = "once@example.com";
    const first = await bootstrapAdmin(db.pool, { email, displayName: "Once" });

    await expect(bootstrapAdmin(db.pool, { email, displayName: "Twice" })).rejects.toBeInstanceOf(
      UserExistsError,
    );

    // Still exactly one user, and exactly one key (no orphaned second key).
    const users = await db.pool.query("SELECT id FROM users WHERE email = $1", [email]);
    expect(users.rows).toHaveLength(1);
    const keys = await db.pool.query("SELECT id FROM api_keys WHERE user_id = $1", [first.user.id]);
    expect(keys.rows).toHaveLength(1);
  });
});
