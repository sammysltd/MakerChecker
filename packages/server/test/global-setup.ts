/**
 * Vitest global setup: provides an admin connection string to a REAL Postgres.
 *
 * - If TEST_DATABASE_URL is set (CI service container), use it.
 * - Otherwise boot a throwaway cluster (initdb + pg_ctl) in a temp dir on a
 *   random port and tear it down after the run. Requires postgres binaries
 *   (e.g. `brew install postgresql@17`); fails loudly if absent — the audit
 *   guarantees are only provable against real Postgres, never a mock.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestProject } from "vitest/node";

function findPgBin(): string {
  const candidates = [
    process.env.PG_BIN,
    "/usr/local/opt/postgresql@17/bin",
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin",
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    try {
      execFileSync(join(dir, "initdb"), ["--version"], { stdio: "pipe" });
      return dir;
    } catch {
      /* try next */
    }
  }
  try {
    execFileSync("initdb", ["--version"], { stdio: "pipe" });
    return "";
  } catch {
    throw new Error(
      "No postgres binaries found. Install postgresql@17 (brew) or set TEST_DATABASE_URL / PG_BIN.",
    );
  }
}

/**
 * Resolution order for the test database:
 *  1. TEST_DATABASE_URL (CI service container)
 *  2. the long-lived docker container `makerchecker-test-pg` on :25432
 *     (preferred locally: zero per-run cluster churn — repeated initdb/pg_ctl
 *     cycles exhaust macOS's SysV shared-memory accounting until reboot)
 *  3. a throwaway initdb cluster (fallback for machines with neither)
 */
const DOCKER_TEST_PG = "postgres://postgres:postgres@127.0.0.1:25432/postgres";

async function reachable(url: string): Promise<boolean> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export default async function setup(project: TestProject): Promise<(() => void) | void> {
  if (process.env.TEST_DATABASE_URL) {
    project.provide("adminDatabaseUrl", process.env.TEST_DATABASE_URL);
    return;
  }

  if (await reachable(DOCKER_TEST_PG)) {
    project.provide("adminDatabaseUrl", DOCKER_TEST_PG);
    return;
  }

  const bin = findPgBin();
  const cmd = (name: string) => (bin ? join(bin, name) : name);
  const dataDir = mkdtempSync(join(tmpdir(), "mc-pg-"));
  const port = 20000 + Math.floor(Math.random() * 9999);

  execFileSync(cmd("initdb"), ["-D", dataDir, "-U", "postgres", "-A", "trust"], { stdio: "pipe" });
  execFileSync(
    cmd("pg_ctl"),
    ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-w", "start", "-l", join(dataDir, "log")],
    { stdio: "pipe" },
  );

  project.provide("adminDatabaseUrl", `postgres://postgres@127.0.0.1:${port}/postgres`);

  return () => {
    try {
      // "fast" (not "immediate"): let postgres clean up its IPC resources —
      // immediate-mode kills are what leak SysV accounting on macOS.
      execFileSync(cmd("pg_ctl"), ["-D", dataDir, "-m", "fast", "stop"], { stdio: "pipe" });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}
