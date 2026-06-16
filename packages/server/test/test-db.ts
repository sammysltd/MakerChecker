import { randomBytes } from "node:crypto";

import pg from "pg";
import { inject } from "vitest";

import { migrate } from "../src/db/migrate.js";

export interface TestDb {
  pool: pg.Pool;
  databaseUrl: string;
  drop(): Promise<void>;
}

/** Creates a fresh database with migrations applied; dropped on cleanup. */
export async function createTestDb(): Promise<TestDb> {
  const adminUrl = inject("adminDatabaseUrl");
  const name = `mc_test_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  // DROP DATABASE WITH (FORCE) terminates idle pooled connections (57P01);
  // without a listener those surface as unhandled 'error' events and fail
  // the run even though every test passed.
  admin.on("error", () => {});
  await admin.query(`CREATE DATABASE ${name}`);

  const databaseUrl = adminUrl.replace(/\/[^/]*$/, `/${name}`);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on("error", () => {});
  await migrate(pool);

  return {
    pool,
    databaseUrl,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Runs fn inside a committed transaction, the way domain services call recordEvent. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
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
