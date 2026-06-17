import { randomBytes } from "node:crypto";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger, loggerOptions } from "./logger.js";

/** Pino over a string-collecting stream, with the shared redaction options. */
function capturingLogger(): { chunks: string[]; logger: ReturnType<typeof pino> } {
  const chunks: string[] = [];
  const stream = { write: (s: string) => chunks.push(s) };
  return { chunks, logger: pino(loggerOptions("info"), stream as never) };
}

describe("logger factory", () => {
  const ORIGINAL = process.env.MAKERCHECKER_LOG_LEVEL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MAKERCHECKER_LOG_LEVEL;
    else process.env.MAKERCHECKER_LOG_LEVEL = ORIGINAL;
  });

  it("defaults to info when MAKERCHECKER_LOG_LEVEL is unset", () => {
    delete process.env.MAKERCHECKER_LOG_LEVEL;
    expect(loggerOptions().level).toBe("info");
    expect(createLogger().level).toBe("info");
  });

  it("honors MAKERCHECKER_LOG_LEVEL", () => {
    process.env.MAKERCHECKER_LOG_LEVEL = "debug";
    expect(loggerOptions().level).toBe("debug");
    expect(createLogger().level).toBe("debug");
  });

  it("honors silent so a configured logger emits nothing", () => {
    process.env.MAKERCHECKER_LOG_LEVEL = "silent";
    const logger = createLogger();
    expect(logger.level).toBe("silent");
    // silent is below every emit level, so nothing is enabled.
    expect(logger.isLevelEnabled("error")).toBe(false);
    expect(logger.isLevelEnabled("info")).toBe(false);
  });

  it("redacts secret-bearing fields in a serialized log line", () => {
    const { chunks, logger } = capturingLogger();
    const bearerKey = `mk_${randomBytes(16).toString("hex")}`;
    const token = `mk_${randomBytes(16).toString("hex")}`;
    const apiKey = `mk_${randomBytes(16).toString("hex")}`;
    logger.info(
      {
        req: { headers: { authorization: `Bearer ${bearerKey}` } },
        token,
        password: "hunter2",
        apiKey,
      },
      "auth attempt",
    );
    const line = chunks.join("");
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain(bearerKey);
    expect(line).not.toContain(token);
    expect(line).not.toContain(apiKey);
    expect(line).not.toContain("hunter2");
    // The non-secret message survives.
    expect(line).toContain("auth attempt");
  });
});
