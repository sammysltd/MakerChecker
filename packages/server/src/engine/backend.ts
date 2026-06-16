/**
 * The seam between the flow engine and whatever executes its tasks.
 * v0 ships GraphileWorkerBackend; a TemporalBackend can slot in later.
 * Keep this interface minimal — do not leak queue-specific features through it.
 */

export interface EnqueueOptions {
  runAt?: Date;
  /** Jobs sharing a key are deduplicated (latest payload wins) while queued. */
  jobKey?: string;
}

export type TaskHandler = (payload: unknown) => Promise<void>;

export interface ExecutionBackend {
  start(handlers: Record<string, TaskHandler>): Promise<void>;
  stop(): Promise<void>;
  enqueue(task: string, payload: unknown, opts?: EnqueueOptions): Promise<void>;
}
