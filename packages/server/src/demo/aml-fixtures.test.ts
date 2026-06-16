/**
 * AML demo fixtures — capture + drift guard.
 *
 * The finance scenario of the marketing "live demo" replays a real
 * aml-alert-triage run through the REAL product components, captured from a
 * genuine seeded run with auth ENABLED (see test/demo-capture.ts). Same
 * anti-drift guarantee as the MDR fixtures.
 *
 * Regenerate:
 *   CAPTURE_WRITE=1 pnpm --filter @makerchecker/server vitest run src/demo/aml-fixtures.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { captureGatedFlow, normalize, withoutRunning } from "../../test/demo-capture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALERTS = join(HERE, "../../../../examples/aml-alert-triage/alerts.csv");
const FIXTURE = join(HERE, "../../../web/src/demo/fixtures/aml.json");
// The demo ingest skills confine reads to the parent of DEMO_DATA_DIR; with it
// pointed inside examples/, the bundled scenario fixtures resolve in-root.
const DEMO_DATA_DIR = join(HERE, "../../../../examples/daily-cash-reconciliation");

interface CapturedStep {
  step_key: string;
  status: string;
  output: { escalatedCount: number; escalations: { alertId: string }[] };
}
interface Captured {
  scenes: {
    waiting: { run: { status: string }; steps: CapturedStep[] };
    completed: { run: { status: string } };
  };
  blockedDecision: { status: number; message: string };
  approvedDecision: { status: number };
  verify: { ok: boolean };
}

describe("AML demo fixtures", () => {
  it(
    "match a freshly-captured real run (drift guard)",
    async () => {
      const savedDataDir = process.env.DEMO_DATA_DIR;
      process.env.DEMO_DATA_DIR = DEMO_DATA_DIR;
      let fresh: Captured;
      try {
        fresh = (await captureGatedFlow({
          flowName: "aml-alert-triage",
          input: { alertsPath: ALERTS },
          requesterEmail: "admin@makerchecker.local",
          officerEmail: "officer@makerchecker.local",
          officerReason:
            "A-2005 (Sable Trading FZE) is a sanctions near-match requiring disposition; A-2007 (Northgate Vending) is a structuring pattern at risk 86. File SARs on both.",
        })) as unknown as Captured;
      } finally {
        if (savedDataDir !== undefined) process.env.DEMO_DATA_DIR = savedDataDir;
        else delete process.env.DEMO_DATA_DIR;
      }

      if (process.env.CAPTURE_WRITE === "1") {
        if (!existsSync(dirname(FIXTURE))) mkdirSync(dirname(FIXTURE), { recursive: true });
        writeFileSync(FIXTURE, JSON.stringify(fresh, null, 2) + "\n");
      }

      // Behaviour invariants — the real product, not the fixture.
      expect(fresh.scenes.waiting.run.status).toBe("waiting_approval");
      const triage = fresh.scenes.waiting.steps.find((s) => s.step_key === "triage")!;
      expect(triage.status).toBe("completed");
      expect(triage.output.escalatedCount).toBe(2);
      expect(triage.output.escalations.map((e) => e.alertId)).toContain("A-2005");
      expect(fresh.blockedDecision.status).toBeGreaterThanOrEqual(400);
      expect(String(fresh.blockedDecision.message).toLowerCase()).toMatch(/approve|request|own/);
      expect(fresh.approvedDecision.status).toBe(200);
      expect(fresh.scenes.completed.run.status).toBe("completed");
      expect(fresh.verify.ok).toBe(true);

      // Shape drift — normalised fresh capture must equal the committed fixture
      // (excluding the racy `running` snapshot).
      expect(existsSync(FIXTURE)).toBe(true);
      const committed = JSON.parse(readFileSync(FIXTURE, "utf8"));
      expect(withoutRunning(normalize(fresh))).toEqual(withoutRunning(normalize(committed)));
    },
    90_000,
  );
});
