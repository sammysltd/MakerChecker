import pino, { type Logger, type LoggerOptions } from "pino";

import { logLevel } from "../config.js";

/**
 * Pino redact paths for the Fastify request logger: secrets that must never
 * reach a log line. Bearer tokens, the mk_ key plaintext, and the instance
 * signing key are masked wherever they appear in a serialized req/headers/body.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["authorization"]',
  "req.headers.cookie",
  "headers.authorization",
  "authorization",
  "apiKey",
  "api_key",
  "password",
  "secret",
  "token",
];

/** Shared pino options (level + redaction) for both the Fastify and worker loggers. */
export function loggerOptions(levelOverride?: string): LoggerOptions {
  return {
    level: levelOverride ?? logLevel(),
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };
}

/** A configured pino instance for non-request contexts (boot, cron, workers). */
export function createLogger(): Logger {
  return pino(loggerOptions());
}

/** Process-lifetime logger for boot/worker code paths that have no request scope. */
export const workerLogger: Logger = createLogger();
