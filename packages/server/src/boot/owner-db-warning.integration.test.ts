import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { migrateGraphileWorkerSchema } from "../engine/graphile-backend.js";
import { emitOwnerDbWarning, OWNER_DB_CREDENTIAL_EVENT } from "./owner-db-warning.js";

/**
 * The owner-db warning is an audit guarantee: a non-demo deployment whose DB
 * credential can rewrite audit_events must leave exactly one
 * 'instance.owner_db_credential' row in the chain, and the hardened non-owner
 * mc_app_runtime role (which cannot tamper) must leave none. The env decision is
 * unit-tested separately; this drives the real probe + write path against Postgres.
 */

const RUNTIME_PASSWORD = "mc-owner-warn-test-pw";
const silent = pino({ level: "silent" });

const ORIGINAL = {
  demo: process.env.MAKERCHECKER_SEED_DEMO,
  nodeEnv: process.env.NODE_ENV,
};

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore("MAKERCHECKER_SEED_DEMO", ORIGINAL.demo);
  restore("NODE_ENV", ORIGINAL.nodeEnv);
});

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

async function eventCount(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM audit_events WHERE event_type = $1",
    [OWNER_DB_CREDENTIAL_EVENT],
  );
  return Number(rows[0]!.n);
}

describe("emitOwnerDbWarning — owner/superuser credential can tamper", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  it("writes one audit event when the connected role can modify audit_events", async () => {
    delete process.env.MAKERCHECKER_SEED_DEMO;
    process.env.NODE_ENV = "production";

    const before = await eventCount(db.pool);
    await emitOwnerDbWarning(db.pool, silent);
    expect(await eventCount(db.pool)).toBe(before + 1);

    const { rows } = await db.pool.query<{ actor: { type: string; id: string }; prev_hash: string }>(
      "SELECT actor, prev_hash FROM audit_events WHERE event_type = $1 ORDER BY seq DESC LIMIT 1",
      [OWNER_DB_CREDENTIAL_EVENT],
    );
    expect(rows[0]!.actor).toMatchObject({ type: "system", id: "boot" });
    expect(rows[0]!.prev_hash).toBeTruthy();
  });

  it("stays silent under the compose demo even on a tamper-capable role", async () => {
    process.env.MAKERCHECKER_SEED_DEMO = "1";
    process.env.NODE_ENV = "production";

    const before = await eventCount(db.pool);
    await emitOwnerDbWarning(db.pool, silent);
    expect(await eventCount(db.pool)).toBe(before);
  });

  it("stays silent under test even on a tamper-capable role", async () => {
    delete process.env.MAKERCHECKER_SEED_DEMO;
    process.env.NODE_ENV = "test";

    const before = await eventCount(db.pool);
    await emitOwnerDbWarning(db.pool, silent);
    expect(await eventCount(db.pool)).toBe(before);
  });

  it("swallows an audit-write failure instead of crashing boot", async () => {
    delete process.env.MAKERCHECKER_SEED_DEMO;
    process.env.NODE_ENV = "production";

    const broken = {
      query: async () => ({ rows: [{ can_tamper_audit_chain: true }] }),
      connect: async () => ({
        query: async (sql: string) => {
          if (sql === "BEGIN") return;
          throw new Error("simulated insert failure");
        },
        release: () => {},
      }),
    } as unknown as pg.Pool;

    await expect(emitOwnerDbWarning(broken, silent)).resolves.toBeUndefined();
  });

  it("swallows a probe failure instead of crashing boot", async () => {
    delete process.env.MAKERCHECKER_SEED_DEMO;
    process.env.NODE_ENV = "production";

    const broken = {
      query: async () => {
        throw new Error("simulated probe failure");
      },
    } as unknown as pg.Pool;

    await expect(emitOwnerDbWarning(broken, silent)).resolves.toBeUndefined();
  });
});

describe("emitOwnerDbWarning — hardened non-owner role cannot tamper", () => {
  let db: TestDb;
  let runtimePool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrateGraphileWorkerSchema(db.pool);

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

    const runtimeUrl = new URL(db.databaseUrl);
    runtimeUrl.username = "mc_app_runtime";
    runtimeUrl.password = RUNTIME_PASSWORD;
    runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString() });
    runtimePool.on("error", () => {});
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    try {
      await db.pool.query("DROP OWNED BY mc_app_runtime");
      await db.pool.query("DROP ROLE IF EXISTS mc_app_runtime");
    } catch {
      /* the role may be referenced by another concurrent test DB; ignore */
    }
    await db.drop();
  });

  it("writes no event and stays silent when the connected role cannot modify audit_events", async () => {
    delete process.env.MAKERCHECKER_SEED_DEMO;
    process.env.NODE_ENV = "production";

    // Capture at warn level so a thrown probe (which logs an error) can't pass
    // as "correctly silent": the probe must run cleanly AND find non-tamper.
    const lines: string[] = [];
    const capturing = pino({ level: "warn" }, { write: (s: string) => lines.push(s) } as never);

    const before = await eventCount(db.pool);
    await emitOwnerDbWarning(runtimePool, capturing);
    expect(await eventCount(db.pool)).toBe(before);
    expect(lines.join("")).not.toContain("failed to probe");
    expect(lines.join("")).not.toContain(OWNER_DB_CREDENTIAL_EVENT);
  });
});
