import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./cli.js";
import { recordEvent } from "./audit/writer.js";
import { createTestDb, withTransaction, type TestDb } from "../test/test-db.js";
import type { AuditBundle } from "./audit/export.js";

let db: TestDb;
let dataDir: string;
let prevDataDir: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  db = await createTestDb();
  // ensureInstanceKeys writes its keypair under MAKERCHECKER_DATA_DIR; isolate
  // it in a tmp dir so the test never touches the repo's ./data directory.
  dataDir = mkdtempSync(join(tmpdir(), "mc-cli-data-"));
  prevDataDir = process.env.MAKERCHECKER_DATA_DIR;
  process.env.MAKERCHECKER_DATA_DIR = dataDir;
}, 60_000);

afterAll(async () => {
  await db.drop();
  rmSync(dataDir, { recursive: true, force: true });
  if (prevDataDir === undefined) delete process.env.MAKERCHECKER_DATA_DIR;
  else process.env.MAKERCHECKER_DATA_DIR = prevDataDir;
});

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

/** Concatenated text written to a spied console method, for substring asserts. */
function captured(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args) => args.join(" ")).join("\n");
}

describe("cli — offline commands (no database)", () => {
  it("treats no command as help: prints usage to stdout and returns 0", async () => {
    // command === undefined falls into the help branch (offline, no pool).
    expect(await main([])).toBe(0);
    expect(captured(logSpy)).toContain("makerchecker <command>");
  });

  it("prints usage to stderr and returns 2 for an unknown command", async () => {
    // An unknown command falls through to the end of main(), which needs a pool
    // for the dispatch attempt before reaching the usage-error branch; inject one
    // so the test never depends on DATABASE_URL.
    expect(await main(["bogus"], db.pool)).toBe(2);
    expect(captured(errorSpy)).toContain("makerchecker <command>");
  });

  it("returns 0 and prints usage to stdout for --help", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(captured(logSpy)).toContain("makerchecker <command>");
  });

  it("returns 0 and prints usage to stdout for the help command", async () => {
    expect(await main(["help"])).toBe(0);
    expect(captured(logSpy)).toContain("Commands:");
  });

  it("returns 0 and prints the schema version for --version", async () => {
    expect(await main(["--version"])).toBe(0);
    expect(captured(logSpy)).toMatch(/audit schema v/);
  });
});

describe("cli — create-api-key", () => {
  it("returns 2 (usage error) when --email is missing", async () => {
    // No pool needed: the missing-flag check short-circuits before any query,
    // but we pass the injected pool so a stray query could not hit a real DB.
    expect(await main(["create-api-key"], db.pool)).toBe(2);
    expect(captured(errorSpy)).toContain("requires --email");
  });

  it("returns 1 when no user has the given email", async () => {
    expect(
      await main(["create-api-key", "--email", "nobody@example.com"], db.pool),
    ).toBe(1);
    expect(captured(errorSpy)).toContain('no user with email "nobody@example.com"');
  });

  it("returns 0 and prints a one-time plaintext key for a seeded user", async () => {
    const email = "key-owner@example.com";
    await db.pool.query(
      "INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2)",
      [email, "Key Owner"],
    );
    expect(await main(["create-api-key", "--email", email], db.pool)).toBe(0);
    // Plaintext keys are `mk_<32 hex>` and printed exactly once to stdout.
    expect(captured(logSpy)).toMatch(/^mk_[0-9a-f]{32}$/m);
  });
});

describe("cli — create-user", () => {
  it("returns 2 (usage error) when --email is missing", async () => {
    expect(await main(["create-user", "--name", "No Email"], db.pool)).toBe(2);
    expect(captured(errorSpy)).toContain("create-user requires --email");
  });

  it("returns 2 (usage error) when --name is missing", async () => {
    expect(await main(["create-user", "--email", "noname@example.com"], db.pool)).toBe(2);
    expect(captured(errorSpy)).toContain("create-user requires --name");
  });

  it("creates a user, prints its id, and writes a user.created audit event", async () => {
    const email = `made-${Math.random().toString(16).slice(2)}@example.com`;
    expect(await main(["create-user", "--email", email, "--name", "Made User"], db.pool)).toBe(0);
    const id = captured(logSpy).trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const user = await db.pool.query<{ is_admin: boolean }>(
      "SELECT is_admin FROM users WHERE id = $1",
      [id],
    );
    expect(user.rows[0]!.is_admin).toBe(false);
    const audit = await db.pool.query(
      "SELECT 1 FROM audit_events WHERE event_type = 'user.created' AND entity_id = $1",
      [id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("--admin sets is_admin on the created user", async () => {
    const email = `boss-${Math.random().toString(16).slice(2)}@example.com`;
    expect(
      await main(["create-user", "--email", email, "--name", "Boss", "--admin"], db.pool),
    ).toBe(0);
    const id = captured(logSpy).trim();
    const user = await db.pool.query<{ is_admin: boolean }>(
      "SELECT is_admin FROM users WHERE id = $1",
      [id],
    );
    expect(user.rows[0]!.is_admin).toBe(true);
  });

  it("ADVERSARIAL: returns 1 when the email already exists", async () => {
    const email = `taken-${Math.random().toString(16).slice(2)}@example.com`;
    expect(await main(["create-user", "--email", email, "--name", "First"], db.pool)).toBe(0);
    logSpy.mockClear();
    expect(await main(["create-user", "--email", email, "--name", "Second"], db.pool)).toBe(1);
    expect(captured(errorSpy)).toContain("already exists");
  });
});

describe("cli — bootstrap-admin", () => {
  it("returns 2 (usage error) when --email is missing", async () => {
    expect(await main(["bootstrap-admin", "--name", "No Email"], db.pool)).toBe(2);
    expect(captured(errorSpy)).toContain("bootstrap-admin requires --email");
  });

  it("returns 2 (usage error) when --name is missing", async () => {
    expect(await main(["bootstrap-admin", "--email", "noname@example.com"], db.pool)).toBe(2);
    expect(captured(errorSpy)).toContain("bootstrap-admin requires --name");
  });

  it("creates an admin, prints a one-time key, and audits user + api_key creation", async () => {
    const email = `first-admin-${Math.random().toString(16).slice(2)}@example.com`;
    expect(
      await main(["bootstrap-admin", "--email", email, "--name", "First Admin"], db.pool),
    ).toBe(0);
    const plaintext = captured(logSpy).trim();
    expect(plaintext).toMatch(/^mk_[0-9a-f]{32}$/);

    const user = await db.pool.query<{ id: string; is_admin: boolean }>(
      "SELECT id, is_admin FROM users WHERE email = $1",
      [email],
    );
    expect(user.rows[0]!.is_admin).toBe(true);
    const userId = user.rows[0]!.id;

    const userAudit = await db.pool.query(
      "SELECT 1 FROM audit_events WHERE event_type = 'user.created' AND entity_id = $1",
      [userId],
    );
    expect(userAudit.rows).toHaveLength(1);
    const keyAudit = await db.pool.query(
      "SELECT 1 FROM audit_events WHERE event_type = 'api_key.created'",
    );
    expect(keyAudit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("ADVERSARIAL: a second bootstrap-admin for the same email returns 1", async () => {
    const email = `solo-${Math.random().toString(16).slice(2)}@example.com`;
    expect(await main(["bootstrap-admin", "--email", email, "--name", "Solo"], db.pool)).toBe(0);
    logSpy.mockClear();
    expect(await main(["bootstrap-admin", "--email", email, "--name", "Solo Again"], db.pool)).toBe(
      1,
    );
    expect(captured(errorSpy)).toContain("already exists");
  });
});

describe("cli — audit verify / export / verify-bundle", () => {
  let bundleFile: string;

  beforeEach(async () => {
    // A real audit event so the chain has content beyond genesis to verify.
    await withTransaction(db.pool, (client) =>
      recordEvent(client, {
        eventType: "test.cli",
        actor: { type: "system" },
        payload: { n: 1 },
      }),
    );
    bundleFile = join(dataDir, `bundle-${Math.random().toString(16).slice(2)}.json`);
  });

  it("verifies the live chain and returns 0", async () => {
    expect(await main(["audit", "verify"], db.pool)).toBe(0);
    expect(captured(logSpy)).toContain('"ok": true');
  });

  it("exports a signed bundle file and returns 0", async () => {
    expect(await main(["audit", "export", "--out", bundleFile], db.pool)).toBe(0);
    expect(captured(logSpy)).toMatch(/wrote \d+ events to/);
    const bundle = JSON.parse(readFileSync(bundleFile, "utf8")) as AuditBundle;
    expect(bundle.manifest).toBeDefined();
    expect(Array.isArray(bundle.events)).toBe(true);
    expect(bundle.manifest.signature).toMatch(/.+/);
  });

  it("verify-bundle accepts a genuine exported bundle offline and returns 0", async () => {
    expect(await main(["audit", "export", "--out", bundleFile], db.pool)).toBe(0);
    // No pool argument: verify-bundle is fully offline.
    expect(await main(["audit", "verify-bundle", "--in", bundleFile])).toBe(0);
    expect(captured(logSpy)).toContain('"ok": true');
  });

  it("ADVERSARIAL: verify-bundle rejects a tampered bundle file and returns 1", async () => {
    expect(await main(["audit", "export", "--out", bundleFile], db.pool)).toBe(0);
    const bundle = JSON.parse(readFileSync(bundleFile, "utf8")) as AuditBundle;
    // Mutate an event payload without re-signing: the per-event hash no longer matches.
    const target = bundle.events.find((e) => e.event_type === "test.cli") ?? bundle.events[0]!;
    target.payload = { n: 999, evil: true };
    writeFileSync(bundleFile, JSON.stringify(bundle));
    expect(await main(["audit", "verify-bundle", "--in", bundleFile])).toBe(1);
  });
});
