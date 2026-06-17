import { describe, expect, it } from "vitest";

import { shouldWarnRedactionOff } from "./redaction-warning.js";

/** Minimal env factory; only the three signals the decision reads matter. */
function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return over as NodeJS.ProcessEnv;
}

describe("shouldWarnRedactionOff", () => {
  it("warns on a non-demo, non-test boot with redaction unset", () => {
    expect(shouldWarnRedactionOff(env())).toBe(true);
    expect(shouldWarnRedactionOff(env({ MAKERCHECKER_REDACTION: "none" }))).toBe(true);
    expect(shouldWarnRedactionOff(env({ MAKERCHECKER_REDACTION: "off" }))).toBe(true);
  });

  it("stays silent when redaction resolves to a built-in", () => {
    expect(shouldWarnRedactionOff(env({ MAKERCHECKER_REDACTION: "example" }))).toBe(false);
    expect(shouldWarnRedactionOff(env({ MAKERCHECKER_REDACTION: "standard" }))).toBe(false);
  });

  it("stays silent for the compose demo", () => {
    expect(shouldWarnRedactionOff(env({ MAKERCHECKER_SEED_DEMO: "1" }))).toBe(false);
  });

  it("stays silent under test (vitest sets NODE_ENV=test)", () => {
    expect(shouldWarnRedactionOff(env({ NODE_ENV: "test" }))).toBe(false);
  });

  it("requires all three gates to warn", () => {
    expect(
      shouldWarnRedactionOff(env({ NODE_ENV: "production", MAKERCHECKER_SEED_DEMO: "0" })),
    ).toBe(true);
    expect(
      shouldWarnRedactionOff(
        env({ NODE_ENV: "production", MAKERCHECKER_SEED_DEMO: "1" }),
      ),
    ).toBe(false);
    expect(
      shouldWarnRedactionOff(
        env({ MAKERCHECKER_REDACTION: "example", MAKERCHECKER_SEED_DEMO: "1", NODE_ENV: "test" }),
      ),
    ).toBe(false);
  });
});
