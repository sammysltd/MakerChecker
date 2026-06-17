import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Runs once per test worker (globalSetup runs in a separate process, so its
    // env never reaches the workers): pins the logger silent so the suite stays
    // quiet without a test asserting on stdout.
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts (listen entrypoint) and cli.ts (thin arg-parsing shell over
      // tested lib functions) are exercised by docker/e2e, not unit tests.
      // backend.ts is a types-only interface file with no executable code.
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/cli.ts", "src/engine/backend.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
