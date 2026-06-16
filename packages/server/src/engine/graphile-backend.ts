import {
  makeWorkerUtils,
  run,
  type ParsedCronItem,
  type Runner,
  type WorkerUtils,
} from "graphile-worker";
import type { Pool } from "pg";

import type { EnqueueOptions, ExecutionBackend, TaskHandler } from "./backend.js";

/** Cron schedules registered at start (built by src/boot/cron.ts). */
export interface GraphileStartOptions {
  parsedCronItems?: ParsedCronItem[];
}

/**
 * graphile-worker implementation. LISTEN/NOTIFY wakeups give sub-second step
 * latency. Queue-level maxAttempts is pinned to 1: retries are ENGINE-managed
 * so every attempt is individually audited — the queue must never silently
 * re-run a task and bypass the audit trail.
 */
export class GraphileWorkerBackend implements ExecutionBackend {
  private runner: Runner | null = null;
  // Memoized as a PROMISE, not the resolved value: concurrent first enqueue()
  // calls must share one makeWorkerUtils() — a check-then-await-then-assign on a
  // nullable instance races (each sees null, each creates, only the last is
  // released in stop() and the rest leak their pg listeners).
  private utilsPromise: Promise<WorkerUtils> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly concurrency = 5,
  ) {}

  async start(
    handlers: Record<string, TaskHandler>,
    options?: GraphileStartOptions,
  ): Promise<void> {
    if (this.runner) throw new Error("backend already started");
    const taskList = Object.fromEntries(
      Object.entries(handlers).map(([name, handler]) => [
        name,
        async (payload: unknown) => {
          await handler(payload);
        },
      ]),
    );
    this.runner = await run({
      pgPool: this.pool,
      taskList,
      concurrency: this.concurrency,
      ...(options?.parsedCronItems ? { parsedCronItems: options.parsedCronItems } : {}),
    });
  }

  async stop(): Promise<void> {
    await this.runner?.stop();
    this.runner = null;
    const utilsPromise = this.utilsPromise;
    this.utilsPromise = null;
    if (utilsPromise) {
      const utils = await utilsPromise;
      await utils.release();
    }
  }

  async enqueue(task: string, payload: unknown, opts?: EnqueueOptions): Promise<void> {
    // Memoize the creation promise so concurrent first calls share one
    // WorkerUtils. Drop the memo if it rejects so a later call can retry,
    // rather than caching a permanently-failed promise.
    this.utilsPromise ??= makeWorkerUtils({ pgPool: this.pool }).catch((err: unknown) => {
      this.utilsPromise = null;
      throw err;
    });
    const utils = await this.utilsPromise;
    await utils.addJob(task, payload, {
      maxAttempts: 1,
      ...(opts?.runAt ? { runAt: opts.runAt } : {}),
      ...(opts?.jobKey ? { jobKey: opts.jobKey, jobKeyMode: "replace" as const } : {}),
    });
  }
}

/**
 * Installs the graphile-worker queue schema. Run as the table owner during
 * `migrate`; the non-owner runtime role only needs USAGE on the schema, since
 * its startup migration check is a no-op once the schema is current.
 */
export async function migrateGraphileWorkerSchema(pool: Pool): Promise<void> {
  const utils = await makeWorkerUtils({ pgPool: pool });
  try {
    await utils.migrate();
  } finally {
    await utils.release();
  }
}
