import { describe, expect, it } from "vitest";

import { shouldCheckOwnerDb } from "./owner-db-warning.js";

/** Minimal env factory; only the two signals the decision reads matter. */
function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return over as NodeJS.ProcessEnv;
}

describe("shouldCheckOwnerDb", () => {
  it("probes on a non-demo, non-test boot", () => {
    expect(shouldCheckOwnerDb(env())).toBe(true);
    expect(shouldCheckOwnerDb(env({ NODE_ENV: "production" }))).toBe(true);
    expect(shouldCheckOwnerDb(env({ MAKERCHECKER_SEED_DEMO: "0" }))).toBe(true);
    expect(
      shouldCheckOwnerDb(env({ NODE_ENV: "production", MAKERCHECKER_SEED_DEMO: "0" })),
    ).toBe(true);
  });

  it("stays silent for the compose demo", () => {
    expect(shouldCheckOwnerDb(env({ MAKERCHECKER_SEED_DEMO: "1" }))).toBe(false);
    expect(
      shouldCheckOwnerDb(env({ MAKERCHECKER_SEED_DEMO: "1", NODE_ENV: "production" })),
    ).toBe(false);
  });

  it("stays silent under test (vitest sets NODE_ENV=test)", () => {
    expect(shouldCheckOwnerDb(env({ NODE_ENV: "test" }))).toBe(false);
    expect(
      shouldCheckOwnerDb(env({ NODE_ENV: "test", MAKERCHECKER_SEED_DEMO: "0" })),
    ).toBe(false);
  });

  it("requires both gates to probe", () => {
    expect(
      shouldCheckOwnerDb(env({ MAKERCHECKER_SEED_DEMO: "1", NODE_ENV: "test" })),
    ).toBe(false);
  });
});
