import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Logger } from "pino";

import type { ExecutionBackend } from "../engine/backend.js";

/** Hard cap on the whole drain so a stuck job or hung close can never block exit. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

let shuttingDown = false;

/** True once shutdown has begun. The /readyz probe reads this to return 503. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Flip the drain flag so /readyz starts reporting 503 before teardown runs. */
export function beginShutdown(): void {
  shuttingDown = true;
}

/** Reset the flag. For tests only — the live process never un-shuts. */
export function resetShutdownState(): void {
  shuttingDown = false;
}

export interface ShutdownDeps {
  app: Pick<FastifyInstance, "close">;
  backend: Pick<ExecutionBackend, "stop">;
  pool: Pick<Pool, "end">;
  /** The watchdog setInterval handle, captured at boot so it can be cleared. */
  watchdog: ReturnType<typeof setInterval>;
  logger: Pick<Logger, "info" | "error">;
}

export interface ShutdownOptions {
  timeoutMs?: number;
}

let inFlight: Promise<void> | null = null;

async function runStep(
  logger: Pick<Logger, "error">,
  label: string,
  step: () => Promise<void> | void,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    logger.error({ step: label, err: { message: (err as Error).message } }, "shutdown step failed");
  }
}

async function drain(deps: ShutdownDeps): Promise<void> {
  await runStep(deps.logger, "app.close", () => deps.app.close());
  await runStep(deps.logger, "backend.stop", () => deps.backend.stop());
  await runStep(deps.logger, "clearInterval", () => clearInterval(deps.watchdog));
  await runStep(deps.logger, "pool.end", () => deps.pool.end());
}

/**
 * Drain in-flight work in dependency-reverse order: flip readiness to 503, stop
 * accepting and finish open HTTP requests (app.close), drain queued jobs
 * (backend.stop), stop the watchdog, then close the pool LAST — both the app and
 * the backend query through the pool while draining. Each step is best-effort:
 * a failure is logged, never fatal. A second call (double SIGTERM) joins the
 * first. A hard timeout forces resolution so a hung drain cannot block exit.
 */
export async function gracefulShutdown(
  deps: ShutdownDeps,
  opts?: ShutdownOptions,
): Promise<void> {
  if (inFlight) return inFlight;
  beginShutdown();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  deps.logger.info({ timeoutMs }, "graceful shutdown starting");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      deps.logger.error({ timeoutMs }, "graceful shutdown timed out; forcing exit");
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });

  inFlight = Promise.race([drain(deps).finally(() => clearTimeout(timer)), guard]).then(() => {
    deps.logger.info("graceful shutdown complete");
  });
  return inFlight;
}

/** Reset the in-flight latch. For tests only. */
export function resetShutdownLatch(): void {
  inFlight = null;
}
