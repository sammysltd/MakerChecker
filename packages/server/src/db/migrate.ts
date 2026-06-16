import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

/**
 * Applies pending .sql migrations in filename order. Each migration runs in
 * its own transaction; an advisory lock serializes concurrent migrators.
 */
export async function migrate(pool: Pool, migrationsDir = MIGRATIONS_DIR): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('makerchecker_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- migrationsDir is a fixed module-relative path (or an operator-passed test override), not request input.
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- file is a .sql name listed from the fixed migrationsDir above, not request input.
      const sql = await readFile(join(migrationsDir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('makerchecker_migrations'))");
    client.release();
  }
}
