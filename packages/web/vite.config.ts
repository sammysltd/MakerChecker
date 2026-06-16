import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// All backend paths live under /api (plus /healthz), proxied to the API
// server in dev; in production the server serves the SPA same-origin, so
// fetches use the same /api-prefixed paths everywhere.
const API_PATHS = ["/api", "/healthz"];

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(API_PATHS.map((p) => [p, "http://localhost:3000"])),
  },
  test: {
    environment: "happy-dom",
    // testing-library auto-cleanup between tests hooks into the global afterEach.
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // main.tsx files are mount points; exercised in the browser, not unit tests.
      exclude: ["src/**/*.test.{ts,tsx}", "src/main.tsx", "src/demo/main.tsx"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
