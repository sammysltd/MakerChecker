import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { emitRedactionDisabledWarning, REDACTION_DISABLED_EVENT } from "./redaction-warning.js";

/**
 * The boot warning is an audit guarantee: a non-demo deployment that boots
 * with redaction off must leave a single 'instance.redaction_disabled' row in
 * the chain, and the compose demo / test runs must leave none. The decision is
 * unit-tested separately; this drives the real write path against Postgres.
 */

let db: TestDb;
const silent = pino({ level: "silent" });

const ORIGINAL = {
  redaction: process.env.MAKERCHECKER_REDACTION,
  demo: process.env.MAKERCHECKER_SEED_DEMO,
  nodeEnv: process.env.NODE_ENV,
};

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  restore("MAKERCHECKER_REDACTION", ORIGINAL.redaction);
  restore("MAKERCHECKER_SEED_DEMO", ORIGINAL.demo);
  restore("NODE_ENV", ORIGINAL.nodeEnv);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function eventCount(): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM audit_events WHERE event_type = $1",
    [REDACTION_DISABLED_EVENT],
  );
  return Number(rows[0]!.n);
}

describe("emitRedactionDisabledWarning", () => {
  it("writes one audit event when redaction is off on a non-demo, non-test boot", async () => {
    delete process.env.MAKERCHECKER_REDACTION;
    delete process.env.MAKERCHECKER_SEED_DEMO;
    process.env.NODE_ENV = "production";

    const before = await eventCount();
    await emitRedactionDisabledWarning(db.pool, silent);
    expect(await eventCount()).toBe(before + 1);

    const { rows } = await db.pool.query<{ actor: { type: string; id: string }; prev_hash: string }>(
      "SELECT actor, prev_hash FROM audit_events WHERE event_type = $1 ORDER BY seq DESC LIMIT 1",
      [REDACTION_DISABLED_EVENT],
    );
    expect(rows[0]!.actor).toMatchObject({ type: "system", id: "boot" });
    expect(rows[0]!.prev_hash).toBeTruthy();
  });

  it("stays silent under the compose demo", async () => {
    delete process.env.MAKERCHECKER_REDACTION;
    process.env.MAKERCHECKER_SEED_DEMO = "1";
    process.env.NODE_ENV = "production";

    const before = await eventCount();
    await emitRedactionDisabledWarning(db.pool, silent);
    expect(await eventCount()).toBe(before);
  });

  it("stays silent under test", async () => {
    delete process.env.MAKERCHECKER_REDACTION;
    delete process.env.MAKERCHECKER_SEED_DEMO;
    process.env.NODE_ENV = "test";

    const before = await eventCount();
    await emitRedactionDisabledWarning(db.pool, silent);
    expect(await eventCount()).toBe(before);
  });

  it("stays silent when redaction is configured", async () => {
    process.env.MAKERCHECKER_REDACTION = "standard";
    delete process.env.MAKERCHECKER_SEED_DEMO;
    process.env.NODE_ENV = "production";

    const before = await eventCount();
    await emitRedactionDisabledWarning(db.pool, silent);
    expect(await eventCount()).toBe(before);
  });

  it("swallows an audit-write failure instead of crashing boot", async () => {
    delete process.env.MAKERCHECKER_REDACTION;
    delete process.env.MAKERCHECKER_SEED_DEMO;
    process.env.NODE_ENV = "production";

    const broken = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql === "BEGIN") return;
          throw new Error("simulated insert failure");
        },
        release: () => {},
      }),
    } as unknown as typeof db.pool;

    await expect(emitRedactionDisabledWarning(broken, silent)).resolves.toBeUndefined();
  });
});
