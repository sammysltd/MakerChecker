import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { GraphileWorkerBackend, migrateGraphileWorkerSchema } from "../engine/graphile-backend.js";

/**
 * Proves the two-role hardened deployment (ops/harden-db.sql) actually boots and
 * enforces: the owner installs the schema + queue, applies the REAL hardening
 * script via psql, and the non-owner mc_app_runtime role then runs a worker job
 * yet is denied every audit-rewrite path at the privilege level.
 */

const RUNTIME_PASSWORD = "mc-hardening-test-pw";

/** Locate psql the same way test/global-setup.ts locates the pg binaries. */
function findPsql(): string {
  const candidates = [
    process.env.PG_BIN,
    "/usr/local/opt/postgresql@17/bin",
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin",
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    try {
      execFileSync(join(dir, "psql"), ["--version"], { stdio: "pipe" });
      return join(dir, "psql");
    } catch {
      /* try next */
    }
  }
  return "psql";
}

const hardenSqlPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../ops/harden-db.sql");

let db: TestDb;
let runtimePool: pg.Pool;
let backend: GraphileWorkerBackend | null = null;

beforeAll(async () => {
  db = await createTestDb();
  // Owner installs the graphile_worker queue schema, exactly as `migrate` does.
  await migrateGraphileWorkerSchema(db.pool);

  // Apply the REAL hardening script as the owner.
  const psql = findPsql();
  execFileSync(
    psql,
    [
      db.databaseUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `mc_runtime_password=${RUNTIME_PASSWORD}`,
      "-f",
      hardenSqlPath,
    ],
    { stdio: "pipe" },
  );

  // Connect as the non-owner runtime role: same host/port/db, runtime credentials.
  const runtimeUrl = new URL(db.databaseUrl);
  runtimeUrl.username = "mc_app_runtime";
  runtimeUrl.password = RUNTIME_PASSWORD;
  runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString() });
  runtimePool.on("error", () => {});
}, 60_000);

afterAll(async () => {
  await backend?.stop();
  await runtimePool?.end();
  // Best-effort role teardown so the next run's CREATE ROLE is clean. Roles are
  // cluster-global, so DROP OWNED first to release any default-privilege entries.
  try {
    await db.pool.query("DROP OWNED BY mc_app_runtime");
    await db.pool.query("DROP ROLE IF EXISTS mc_app_runtime");
  } catch {
    /* the role may be referenced by another concurrent test DB; ignore */
  }
  await db.drop();
});

describe("hardened deployment (non-owner runtime role)", () => {
  it("the non-owner runtime role can run a worker job", async () => {
    let ran = false;
    backend = new GraphileWorkerBackend(runtimePool, 1);
    await backend.start({
      "harden-test-task": async () => {
        ran = true;
      },
    });
    await backend.enqueue("harden-test-task", {});

    const deadline = Date.now() + 10_000;
    while (!ran && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(ran).toBe(true);
  });

  it("holds INSERT but not UPDATE/DELETE on audit_events, and nothing on instance writes", async () => {
    const { rows } = await runtimePool.query<{
      audit_insert: boolean;
      audit_update: boolean;
      audit_delete: boolean;
      instance_insert: boolean;
      instance_update: boolean;
    }>(
      `SELECT
         has_table_privilege('audit_events', 'INSERT') AS audit_insert,
         has_table_privilege('audit_events', 'UPDATE') AS audit_update,
         has_table_privilege('audit_events', 'DELETE') AS audit_delete,
         has_table_privilege('instance', 'INSERT')      AS instance_insert,
         has_table_privilege('instance', 'UPDATE')      AS instance_update`,
    );
    expect(rows[0]).toEqual({
      audit_insert: true,
      audit_update: false,
      audit_delete: false,
      instance_insert: false,
      instance_update: false,
    });
  });

  it("UPDATE audit_events is denied at the privilege level", async () => {
    await expect(
      runtimePool.query("UPDATE audit_events SET event_type = 'x'"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
