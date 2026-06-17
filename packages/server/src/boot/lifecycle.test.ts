import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginShutdown,
  gracefulShutdown,
  isShuttingDown,
  resetShutdownLatch,
  resetShutdownState,
  type ShutdownDeps,
} from "./lifecycle.js";

const silentLogger = { info: () => {}, error: () => {} };

function makeDeps(over: Partial<ShutdownDeps> = {}): { deps: ShutdownDeps; order: string[] } {
  const order: string[] = [];
  const deps: ShutdownDeps = {
    app: { close: vi.fn(async () => void order.push("app.close")) },
    backend: { stop: vi.fn(async () => void order.push("backend.stop")) },
    pool: { end: vi.fn(async () => void order.push("pool.end")) },
    watchdog: setInterval(() => {}, 1_000),
    logger: silentLogger,
    ...over,
  } as ShutdownDeps;
  return { deps, order };
}

afterEach(() => {
  resetShutdownState();
  resetShutdownLatch();
});

describe("shutdown flag", () => {
  it("defaults to false and flips on beginShutdown", () => {
    expect(isShuttingDown()).toBe(false);
    beginShutdown();
    expect(isShuttingDown()).toBe(true);
  });
});

describe("gracefulShutdown", () => {
  it("tears down in dependency-reverse order with the pool last", async () => {
    const { deps, order } = makeDeps();
    const cleared = vi.spyOn(globalThis, "clearInterval");

    await gracefulShutdown(deps, { timeoutMs: 5_000 });

    expect(order).toEqual(["app.close", "backend.stop", "pool.end"]);
    expect(cleared).toHaveBeenCalledWith(deps.watchdog);
    expect(isShuttingDown()).toBe(true);
    cleared.mockRestore();
  });

  it("sets the readiness flag before any teardown runs", async () => {
    let flagDuringClose: boolean | undefined;
    const { deps } = makeDeps({
      app: { close: vi.fn(async () => void (flagDuringClose = isShuttingDown())) },
    });

    await gracefulShutdown(deps, { timeoutMs: 5_000 });

    expect(flagDuringClose).toBe(true);
  });

  it("is idempotent: a second call does not re-run teardown", async () => {
    const { deps } = makeDeps();

    await gracefulShutdown(deps, { timeoutMs: 5_000 });
    await gracefulShutdown(deps, { timeoutMs: 5_000 });

    expect(deps.app.close).toHaveBeenCalledTimes(1);
    expect(deps.backend.stop).toHaveBeenCalledTimes(1);
    expect(deps.pool.end).toHaveBeenCalledTimes(1);
  });

  it("joins a concurrent second call to the in-flight drain", async () => {
    const { deps } = makeDeps();
    const first = gracefulShutdown(deps, { timeoutMs: 5_000 });
    const second = gracefulShutdown(deps, { timeoutMs: 5_000 });
    await Promise.all([first, second]);
    expect(deps.pool.end).toHaveBeenCalledTimes(1);
  });

  it("continues teardown when an earlier step throws (best-effort)", async () => {
    const { deps, order } = makeDeps({
      app: {
        close: vi.fn(async () => {
          throw new Error("close boom");
        }),
      },
    });

    await gracefulShutdown(deps, { timeoutMs: 5_000 });

    expect(order).toEqual(["backend.stop", "pool.end"]);
    expect(deps.pool.end).toHaveBeenCalledTimes(1);
  });

  it("logs a failed step without aborting", async () => {
    const errored = vi.fn();
    const { deps } = makeDeps({
      logger: { info: () => {}, error: errored },
      backend: {
        stop: vi.fn(async () => {
          throw new Error("stop boom");
        }),
      },
    });

    await gracefulShutdown(deps, { timeoutMs: 5_000 });

    expect(errored).toHaveBeenCalled();
    expect(deps.pool.end).toHaveBeenCalledTimes(1);
  });

  it("resolves on the hard timeout when a step hangs forever", async () => {
    vi.useFakeTimers();
    try {
      const { deps } = makeDeps({
        backend: { stop: vi.fn(() => new Promise<void>(() => {})) },
      });
      const errored = vi.fn();
      deps.logger = { info: () => {}, error: errored };

      const done = gracefulShutdown(deps, { timeoutMs: 25_000 });
      await vi.advanceTimersByTimeAsync(25_000);
      await done;

      expect(errored).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 25_000 }),
        expect.stringMatching(/timed out/),
      );
      expect(deps.pool.end).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
