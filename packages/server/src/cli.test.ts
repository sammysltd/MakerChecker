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
