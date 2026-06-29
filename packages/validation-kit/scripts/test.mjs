/**
 * Tests the validation-kit against the proof-verifier's real signed bundle:
 * the baseline protocol should qualify it (IQ/OQ/PQ pass, RTM covered), and the
 * rendered report must contain the expected sections.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateValidation, RESULT } from "../src/generate.js";
import { renderReport } from "../src/report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const bundle = JSON.parse(readFileSync(join(HERE, "..", "..", "proof-verifier", "vectors", "valid-full.json"), "utf8"));
const tampered = JSON.parse(readFileSync(join(HERE, "..", "..", "proof-verifier", "vectors", "tampered-payload.json"), "utf8"));
const protocol = JSON.parse(readFileSync(join(HERE, "..", "protocols", "agent-governance-baseline.json"), "utf8"));

let failures = 0;
const check = (cond, msg) => { if (cond) console.log(`  ok  ${msg}`); else { console.error(`  FAIL ${msg}`); failures++; } };

// ---- A: a valid governed run qualifies ----
const v = await generateValidation(bundle, protocol);
const byId = Object.fromEntries(v.tests.map((t) => [t.id, t]));
check(v.reliable, "chain verifies");
check(byId["IQ-001"].result === RESULT.PASS, "IQ-001 genesis + chain PASS");
check(byId["OQ-001"].result === RESULT.PASS && byId["OQ-001"].citedSeqs.length > 0, "OQ-001 deny-by-default PASS with cited evidence");
check(byId["OQ-002"].result === RESULT.PASS, "OQ-002 high-risk gate PASS");
check(byId["PQ-001"].result === RESULT.PASS, "PQ-001 end-to-end run PASS");
check(byId["OQ-004"].result === RESULT.NOT_APPLICABLE, "OQ-004 limits NOT_APPLICABLE (no limit hit in this run)");
check(v.summary.FAIL === 0, "no test failed");
check(v.qualified === true, "overall QUALIFIED");
check(v.summary.requirementsCovered >= 4, `requirements covered (${v.summary.requirementsCovered}/${v.summary.requirementsTotal})`);

// RTM coverage: URS-001 (deny-by-default) must be covered.
const rtmById = Object.fromEntries(v.rtm.map((r) => [r.urs, r]));
check(rtmById["URS-001"].covered, "RTM: URS-001 covered");
check(rtmById["URS-003"].covered, "RTM: URS-003 (audit trail) covered");

// Report renders with the key sections.
const md = renderReport(v, { generatedAt: "2026-06-29" });
for (const section of ["Installation Qualification", "Operational Qualification", "Performance Qualification", "Requirements Traceability Matrix", "QUALIFIED"]) {
  check(md.includes(section), `report contains "${section}"`);
}

// ---- B: a tampered bundle must NOT qualify ----
const t = await generateValidation(tampered, protocol);
check(t.reliable === false, "tampered chain does not verify");
check(t.qualified === false, "tampered bundle NOT qualified");
check(renderReport(t).includes("NOT QUALIFIED"), "tampered report says NOT QUALIFIED");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
