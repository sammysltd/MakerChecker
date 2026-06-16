import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock graphile-worker at the module level so we can count makeWorkerUtils()
// calls and prove the lazy init is memoized — no real Postgres needed. The
// fake makeWorkerUtils awaits a deferred gate before resolving, so several
// enqueue() calls overlap in the exact window where the old
// check-then-await-then-assign code raced (every caller saw `utils === null`).

interface FakeWorkerUtils {
  addJob: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

let createdUtils: FakeWorkerUtils[] = [];
// Resolves the in-flight makeWorkerUtils() call(s); set per test.
let releaseGate: (() => void) | null = null;
const makeWorkerUtils = vi.fn(async (): Promise<FakeWorkerUtils> => {
  await new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const utils: FakeWorkerUtils = {
    addJob: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  createdUtils.push(utils);
  return utils;
});

vi.mock("graphile-worker", () => ({
  makeWorkerUtils: (opts: unknown) => makeWorkerUtils(opts),
  run: vi.fn(),
}));

const { GraphileWorkerBackend } = await import("./graphile-backend.js");

// The pool is never actually touched by the mock; a sentinel object is enough.
function fakePool(): import("pg").Pool {
  return {} as unknown as import("pg").Pool;
}

beforeEach(() => {
  createdUtils = [];
  releaseGate = null;
  makeWorkerUtils.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GraphileWorkerBackend lazy WorkerUtils init", () => {
  it("creates exactly one WorkerUtils under concurrent first enqueue() calls", async () => {
    const backend = new GraphileWorkerBackend(fakePool());

    // Fire several enqueue() calls before any makeWorkerUtils() resolves. With
    // the buggy non-memoized version each would call makeWorkerUtils and leak.
    const enqueues = Promise.all(
      Array.from({ length: 8 }, (_, i) => backend.enqueue("task", { i })),
    );

    // Let the (single) in-flight creation finish, then drain microtasks.
    await vi.waitFor(() => expect(releaseGate).not.toBeNull());
    releaseGate?.();
    await enqueues;

    expect(makeWorkerUtils).toHaveBeenCalledTimes(1);
    expect(createdUtils).toHaveLength(1);
    // All eight jobs went onto the one WorkerUtils.
    expect(createdUtils[0]?.addJob).toHaveBeenCalledTimes(8);
  });

  it("reuses the same WorkerUtils across sequential enqueue() calls", async () => {
    const backend = new GraphileWorkerBackend(fakePool());

    const first = backend.enqueue("task", { n: 1 });
    await vi.waitFor(() => expect(releaseGate).not.toBeNull());
    releaseGate?.();
    await first;

    // Second call happens after the first fully resolved: the memo is warm.
    await backend.enqueue("task", { n: 2 });

    expect(makeWorkerUtils).toHaveBeenCalledTimes(1);
    expect(createdUtils[0]?.addJob).toHaveBeenCalledTimes(2);
  });

  it("releases the single WorkerUtils on stop()", async () => {
    const backend = new GraphileWorkerBackend(fakePool());

    const enqueues = Promise.all([
      backend.enqueue("task", {}),
      backend.enqueue("task", {}),
    ]);
    await vi.waitFor(() => expect(releaseGate).not.toBeNull());
    releaseGate?.();
    await enqueues;

    await backend.stop();

    expect(createdUtils).toHaveLength(1);
    expect(createdUtils[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("stop() with no enqueue() never creates or releases WorkerUtils", async () => {
    const backend = new GraphileWorkerBackend(fakePool());
    await backend.stop();
    expect(makeWorkerUtils).not.toHaveBeenCalled();
    expect(createdUtils).toHaveLength(0);
  });

  it("retries creation after a failed makeWorkerUtils() (memo not poisoned)", async () => {
    const backend = new GraphileWorkerBackend(fakePool());

    makeWorkerUtils.mockImplementationOnce(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    await expect(backend.enqueue("task", {})).rejects.toThrow("ECONNREFUSED");
    expect(createdUtils).toHaveLength(0);

    // A later call must be able to create a fresh WorkerUtils, not reuse the
    // rejected promise.
    const retry = backend.enqueue("task", {});
    await vi.waitFor(() => expect(releaseGate).not.toBeNull());
    releaseGate?.();
    await retry;

    expect(makeWorkerUtils).toHaveBeenCalledTimes(2);
    expect(createdUtils).toHaveLength(1);
    expect(createdUtils[0]?.addJob).toHaveBeenCalledTimes(1);
  });
});
