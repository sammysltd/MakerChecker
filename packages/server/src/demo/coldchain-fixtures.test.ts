/**
 * Cold-chain demo fixtures — capture + drift guard.
 *
 * The vaccine cold-chain scenario of the live demo replays a real
 * cold-chain-disposition run: an agent catches a temperature excursion,
 * quarantines the affected lots, and tries to decide their disposition;
 * MakerChecker blocks the self-disposition (forbid_requester); a QA person
 * signs release-or-destroy. Captured from a genuine seeded run with auth ENABLED.
 *
 * Regenerate:
 *   CAPTURE_WRITE=1 pnpm --filter @makerchecker/server vitest run src/demo/coldchain-fixtures.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { captureGatedFlow, normalize, withoutRunning } from "../../test/demo-capture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXCURSIONS = join(HERE, "../../../../examples/cold-chain-disposition/excursions.csv");
const LIMITS = join(HERE, "../../../../examples/cold-chain-disposition/stability_limits.csv");
const READINGS = join(HERE, "../../../../examples/cold-chain-disposition/readings.csv");
const FIXTURE = join(HERE, "../../../web/src/demo/fixtures/coldchain.json");
// The demo ingest skills confine reads to the parent of DEMO_DATA_DIR; with it
// pointed inside examples/, the bundled scenario fixtures resolve in-root.
const DEMO_DATA_DIR = join(HERE, "../../../../examples/daily-cash-reconciliation");

interface Captured {
  scenes: {
    waiting: { run: { status: string }; steps: { step_key: string; status: string }[] };
    completed: { run: { status: string } };
  };
  blockedDecision: { status: number; message: string };
  approvedDecision: { status: number };
  verify: { ok: boolean };
}

describe("Cold-chain demo fixtures", () => {
  it(
    "match a freshly-captured real run (drift guard)",
    async () => {
      const savedDataDir = process.env.DEMO_DATA_DIR;
      process.env.DEMO_DATA_DIR = DEMO_DATA_DIR;
      let fresh: Captured;
      try {
        fresh = (await captureGatedFlow({
          flowName: "cold-chain-disposition",
          input: { excursionsPath: EXCURSIONS, limitsPath: LIMITS, readingsPath: READINGS },
          requesterEmail: "admin@makerchecker.local",
          officerEmail: "officer@makerchecker.local",
          officerReason:
            "Lots exceeding stability limits during the excursion are to be destroyed; unaffected lots released. Quarantine confirmed.",
        })) as unknown as Captured;
      } finally {
        if (savedDataDir !== undefined) process.env.DEMO_DATA_DIR = savedDataDir;
        else delete process.env.DEMO_DATA_DIR;
      }

      if (process.env.CAPTURE_WRITE === "1") {
        if (!existsSync(dirname(FIXTURE))) mkdirSync(dirname(FIXTURE), { recursive: true });
        writeFileSync(FIXTURE, JSON.stringify(fresh, null, 2) + "\n");
      }

      expect(fresh.scenes.waiting.run.status).toBe("waiting_approval");
      const assess = fresh.scenes.waiting.steps.find((s) => s.step_key === "assess")!;
      expect(assess.status).toBe("completed");
      expect(fresh.blockedDecision.status).toBeGreaterThanOrEqual(400);
      expect(String(fresh.blockedDecision.message).toLowerCase()).toMatch(/approve|request|own|decide/);
      expect(fresh.approvedDecision.status).toBe(200);
      expect(fresh.scenes.completed.run.status).toBe("completed");
      expect(fresh.verify.ok).toBe(true);

      expect(existsSync(FIXTURE)).toBe(true);
      const committed = JSON.parse(readFileSync(FIXTURE, "utf8"));
      expect(withoutRunning(normalize(fresh))).toEqual(withoutRunning(normalize(committed)));
    },
    90_000,
  );
});
