/**
 * MDR demo fixtures — capture + drift guard.
 *
 * The marketing "live demo" (makerchecker-site/public/demo) replays a real
 * MDR-reportability run through the REAL product components. Its data is NOT
 * hand-written: it is captured from a genuine seeded run against real Postgres
 * with auth ENABLED (see test/demo-capture.ts), so the maker-checker block is
 * the product's actual forbid_requester rejection.
 *
 * This test is the anti-drift guarantee: every CI run captures afresh and
 * asserts the behaviour invariants plus the normalised SHAPE against the
 * committed fixture the demo ships. If the API shape changes, this fails until
 * the fixture is regenerated — so the demo can never silently diverge.
 *
 * Regenerate the committed fixture:
 *   CAPTURE_WRITE=1 pnpm --filter @makerchecker/server vitest run src/demo/mdr-fixtures.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { captureGatedFlow, normalize, withoutRunning } from "../../test/demo-capture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPLAINTS = join(HERE, "../../../../examples/mdr-reportability-triage/complaints.csv");
const FIXTURE = join(HERE, "../../../web/src/demo/fixtures/mdr.json");
// The demo ingest skills confine reads to the parent of DEMO_DATA_DIR; with it
// pointed inside examples/, the bundled scenario fixtures resolve in-root.
const DEMO_DATA_DIR = join(HERE, "../../../../examples/daily-cash-reconciliation");

interface CapturedStep {
  step_key: string;
  status: string;
  output: { escalatedCount: number; escalations: { complaintId: string }[] };
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

describe("MDR demo fixtures", () => {
  it(
    "match a freshly-captured real run (drift guard)",
    async () => {
      const savedDataDir = process.env.DEMO_DATA_DIR;
      process.env.DEMO_DATA_DIR = DEMO_DATA_DIR;
      let fresh: Captured;
      try {
        fresh = (await captureGatedFlow({
          flowName: "mdr-reportability-triage",
          input: { complaintsPath: COMPLAINTS },
          requesterEmail: "admin@makerchecker.local",
          officerEmail: "officer@makerchecker.local",
          officerReason:
            "C-3004 (InsuFlow MX insulin pump) is a reportable serious injury; C-3008 (VentAssist 300) is a malfunction likely to recur. File both within the 30-day MDR clock.",
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
      expect(triage.output.escalations.map((e) => e.complaintId)).toContain("C-3004");
      expect(fresh.blockedDecision.status).toBeGreaterThanOrEqual(400);
      expect(String(fresh.blockedDecision.message).toLowerCase()).toMatch(/approve|request|own/);
      expect(fresh.approvedDecision.status).toBe(200);
      expect(fresh.scenes.completed.run.status).toBe("completed");
      expect(fresh.verify.ok).toBe(true);

      // Shape drift — normalised fresh capture must equal the committed fixture.
      // The `running` snapshot is timing-dependent, so it is excluded; the
      // deterministic scenes guard the RunDetail shape.
      expect(existsSync(FIXTURE)).toBe(true);
      const committed = JSON.parse(readFileSync(FIXTURE, "utf8"));
      expect(withoutRunning(normalize(fresh))).toEqual(withoutRunning(normalize(committed)));
    },
    90_000,
  );
});
