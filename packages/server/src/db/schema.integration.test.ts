import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("migrations", () => {
  it("are idempotent", async () => {
    await expect(migrate(db.pool)).resolves.toEqual([]);
  });

  it("roll back a failing migration atomically", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mc-mig-"));
    try {
      writeFileSync(
        join(dir, "9999_bad.sql"),
        "CREATE TABLE half_done (id int); SELECT nonsense_function();",
      );
      await expect(migrate(db.pool, dir)).rejects.toThrow(/9999_bad\.sql failed/);
      // The CREATE TABLE inside the failed migration must not survive.
      const { rows } = await db.pool.query(
        "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'half_done'",
      );
      expect(rows[0].n).toBe("0");
      const recorded = await db.pool.query(
        "SELECT count(*) AS n FROM schema_migrations WHERE name = '9999_bad.sql'",
      );
      expect(recorded.rows[0].n).toBe("0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("created exactly one instance row", async () => {
    const { rows } = await db.pool.query("SELECT count(*) AS n FROM instance");
    expect(rows[0].n).toBe("1");
  });
});

describe("createPool", () => {
  it("throws without a connection string", () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => createPool()).toThrow(/DATABASE_URL/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it("connects with an explicit connection string", async () => {
    const pool = createPool(db.databaseUrl);
    const { rows } = await pool.query("SELECT 1 AS one");
    expect(rows[0].one).toBe(1);
    await pool.end();
  });
});

describe("governed-entity immutability", () => {
  it("skills: published rows reject edits, allow only deprecation", async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('csv-ingest', 1, '{}', '{}', '{"type":"local"}', 'low') RETURNING id`,
    );
    const id = rows[0]!.id;

    await expect(
      db.pool.query("UPDATE skills SET risk_tier = 'high' WHERE id = $1", [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query("UPDATE skills SET implementation = '{\"type\":\"http\"}' WHERE id = $1", [id]),
    ).rejects.toThrow(/immutable/);

    await db.pool.query("UPDATE skills SET status = 'deprecated' WHERE id = $1", [id]);
    const after = await db.pool.query("SELECT status FROM skills WHERE id = $1", [id]);
    expect(after.rows[0].status).toBe("deprecated");
  });

  it("skills: same name requires a new version, and (name, version) is unique", async () => {
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('csv-ingest', 2, '{}', '{}', '{"type":"local"}', 'low')`,
    );
    await expect(
      db.pool.query(
        `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
         VALUES ('csv-ingest', 2, '{}', '{}', '{"type":"local"}', 'low')`,
      ),
    ).rejects.toThrow(/unique/i);
  });

  it("flow_versions: drafts are editable, published rows only archive", async () => {
    const flow = await db.pool.query<{ id: string }>(
      "INSERT INTO flows (name) VALUES ('recon') RETURNING id",
    );
    const fv = await db.pool.query<{ id: string }>(
      `INSERT INTO flow_versions (flow_id, version, definition)
       VALUES ($1, 1, '{"steps":[]}') RETURNING id`,
      [flow.rows[0]!.id],
    );
    const id = fv.rows[0]!.id;

    // Draft: edit + publish allowed.
    await db.pool.query(
      `UPDATE flow_versions SET definition = '{"steps":[{"key":"prepare"}]}' WHERE id = $1`,
      [id],
    );
    await db.pool.query("UPDATE flow_versions SET status = 'published' WHERE id = $1", [id]);

    // Published: edits rejected, archive allowed.
    await expect(
      db.pool.query(`UPDATE flow_versions SET definition = '{"steps":[]}' WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await db.pool.query("UPDATE flow_versions SET status = 'archived' WHERE id = $1", [id]);
  });

  it("instance: id is immutable, the row is undeletable, and the key is write-once", async () => {
    // The instance row anchors the audit genesis hash and the export signing
    // identity, so it is as immutable as any governed entity (0007).
    const fresh = await createTestDb();
    try {
      const { rows } = await fresh.pool.query<{ id: string }>("SELECT id FROM instance");
      const id = rows[0]!.id;

      // id anchors genesisPrevHash → changing it would rebase the whole chain.
      await expect(
        fresh.pool.query("UPDATE instance SET id = gen_random_uuid()"),
      ).rejects.toThrow(/immutable/);
      // Deleting the row is a re-rooting vector → blocked (DELETE and TRUNCATE).
      await expect(fresh.pool.query("DELETE FROM instance")).rejects.toThrow(/immutable/);
      await expect(fresh.pool.query("TRUNCATE instance")).rejects.toThrow(/truncated/);
      // A second row would make `SELECT id FROM instance LIMIT 1` attacker-chosen.
      await expect(
        fresh.pool.query("INSERT INTO instance DEFAULT VALUES"),
      ).rejects.toThrow(/single-row/);

      // public_key_pem: first publication (NULL -> value) is allowed...
      await fresh.pool.query("UPDATE instance SET public_key_pem = 'KEY-A' WHERE id = $1", [id]);
      // ...idempotent re-write of the SAME value is allowed (boot is idempotent)...
      await fresh.pool.query("UPDATE instance SET public_key_pem = 'KEY-A' WHERE id = $1", [id]);
      // ...but rotating to a DIFFERENT key in place is rejected (silent-swap defence).
      await expect(
        fresh.pool.query("UPDATE instance SET public_key_pem = 'KEY-B' WHERE id = $1", [id]),
      ).rejects.toThrow(/write-once|rotate/);
    } finally {
      await fresh.drop();
    }
  });

  it("sod_constraints: rejects unordered and self-referential pairs", async () => {
    const roles = await db.pool.query<{ id: string }>(
      "INSERT INTO roles (name) VALUES ('preparer'), ('approver') RETURNING id",
    );
    const [a, b] = [roles.rows[0]!.id, roles.rows[1]!.id].sort();

    await db.pool.query(
      "INSERT INTO sod_constraints (role_a_id, role_b_id) VALUES ($1, $2)",
      [a, b],
    );
    await expect(
      db.pool.query("INSERT INTO sod_constraints (role_a_id, role_b_id) VALUES ($1, $2)", [b, a]),
    ).rejects.toThrow(/check/i);
    await expect(
      db.pool.query("INSERT INTO sod_constraints (role_a_id, role_b_id) VALUES ($1, $1)", [a]),
    ).rejects.toThrow(/check/i);
  });
});
