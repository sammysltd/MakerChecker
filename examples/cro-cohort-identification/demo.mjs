#!/usr/bin/env node
// CRO cohort identification for oncology trials: a pre-screening agent reads a
// candidate population against tight inclusion/exclusion criteria (line of
// therapy, biomarker/mutation status, ECOG, prior treatments, washout, disease
// progression) and proposes which records look eligible.
//
// The asymmetry: screening records and computing matched/unmatched criteria
// with supporting evidence is reversible advisory work — granted to the
// screening agent. Attesting that a patient MEETS the inclusion/exclusion
// criteria is the eligibility determination that advances a human toward
// enrollment; a wrong inclusion is a protocol deviation and an ICH-GCP
// data-integrity and patient-safety finding. So eligibility-attest@1 is
// published high-risk: the screener holds no grant for it (deny-by-default),
// and even the sub-investigator/PI who does hold the grant cannot attest inline
// on the proxy — it must run through a governed flow with a preceding approval
// gate. AI drafts the match; a named investigator signs the determination.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/cro-cohort-identification/demo.mjs
import {
  connect,
  ensureSkill,
  ensureRole,
  ensureAgent,
  ensureGrant,
  governedTool,
  GovernanceDeniedError,
  printTrailAndVerify,
} from "../lib/scenario.mjs";

const client = connect();

// --- Configure MakerChecker for the scenario -------------------------------
const screen = await ensureSkill(client, "cro-cohort-screen@1", {
  description: "Screen candidate records against the protocol I/E criteria; proposes only",
});
const match = await ensureSkill(client, "cro-criteria-match@1", {
  description: "Compute matched/unmatched criteria per candidate with the supporting evidence",
});
const attest = await ensureSkill(client, "cro-eligibility-attest@1", {
  riskTier: "high",
  description: "Attest a candidate meets I/E criteria and advance to screening (irreversible determination)",
});

// cohort-screener screens and matches criteria but holds NO attest grant.
const screenerRole = await ensureRole(client, "cro-cohort-screener", {
  description: "Screens candidates and computes criteria matches; cannot attest eligibility.",
});
// sub-investigator holds the attest grant, but the attest skill is high-risk,
// so even a granted role cannot run it inline — it must pass an approval gate.
const investigatorRole = await ensureRole(client, "cro-sub-investigator", {
  description: "Attests eligibility only through a governed flow with an investigator sign-off gate.",
});

await ensureGrant(client, screenerRole, screen);
await ensureGrant(client, screenerRole, match);
await ensureGrant(client, investigatorRole, attest);

await ensureAgent(client, "cro-screener-bot", "cro-cohort-screener");
await ensureAgent(client, "cro-investigator-bot", "cro-sub-investigator");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "cro-cohort-identification" });
console.log(`proxy session ${session.id} opened\n`);

const screenCandidate = governedTool(client, session.id, "cro-screener-bot", "cro-cohort-screen@1", async (i) => ({
  candidate: i.patientId,
  tumorType: i.tumorType,
  proposal: i.proposal,
}));
const matchCriteria = governedTool(client, session.id, "cro-screener-bot", "cro-criteria-match@1", async (i) => ({
  candidate: i.patientId,
  matched: i.matched,
  unmatched: i.unmatched,
  evidence: i.evidence,
}));
const screenerAttest = governedTool(client, session.id, "cro-screener-bot", "cro-eligibility-attest@1", async () => {
  throw new Error("unreachable: deny-by-default blocks this");
});
const investigatorAttest = governedTool(client, session.id, "cro-investigator-bot", "cro-eligibility-attest@1", async () => {
  throw new Error("unreachable: high-risk is refused on the proxy");
});

// 1. The screener screens a fully-matched candidate — allowed (it holds the
//    screen grant). PT-7001: NSCLC, EGFR+, ECOG 1, one prior line, washout met,
//    confirmed progression — clears every inclusion and trips no exclusion.
console.log("screener screens fully-matched candidate:", JSON.stringify(await screenCandidate({
  patientId: "PT-7001",
  tumorType: "NSCLC",
  proposal: "all inclusion criteria met, no exclusion tripped",
})));

// 2. The screener computes the criteria match with evidence — allowed
//    (reversible, granted). Every I/E criterion resolves cleanly here.
console.log("screener matches criteria (PT-7001):", JSON.stringify(await matchCriteria({
  patientId: "PT-7001",
  matched: ["INC-1 tumor_type=NSCLC", "INC-2 mutation=EGFR", "INC-3 ecog<=1", "INC-4 washout>=21d", "EXC-1 prior_lines<=2 ok"],
  unmatched: [],
  evidence: "biomarker report EGFR exon 19 del; ECOG 1 per clinic note 2026-06-02; last therapy +28d",
})));

// 3. The screener screens the borderline candidate — still allowed: screening
//    and matching are advisory. PT-7005 trips INC-5 (confirmed progression):
//    the progression note is ambiguous ("possible progression, repeat imaging
//    pending"), so the match is flagged unresolved rather than asserted.
console.log("screener screens borderline candidate:", JSON.stringify(await screenCandidate({
  patientId: "PT-7005",
  tumorType: "NSCLC",
  proposal: "INC-5 unresolved — ambiguous progression note, route to investigator",
})));

console.log("screener matches criteria (PT-7005):", JSON.stringify(await matchCriteria({
  patientId: "PT-7005",
  matched: ["INC-1 tumor_type=NSCLC", "INC-2 mutation=EGFR", "INC-3 ecog<=1", "INC-4 washout>=21d"],
  unmatched: ["INC-5 confirmed_progression UNRESOLVED"],
  evidence: "radiology note 2026-06-05: 'possible progression, repeat imaging pending' — not a confirmed RECIST progression",
})));

// 4. The screener tries to attest PT-7001 eligible itself — denied by default;
//    the screening role holds no attest grant, so the determination never
//    reaches a tool body. The agent cannot advance a patient on its own.
try {
  await screenerAttest({ patientId: "PT-7001" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`screener eligibility attest DENIED (${err.code}): ${err.reason}`);
}

// 5. Even the granted sub-investigator cannot attest inline: the attest skill
//    is high-risk, categorically refused on the proxy. The eligibility
//    determination only proceeds through the governed flow, where it parks at
//    the investigator sign-off gate. The borderline PT-7005 is exactly the
//    record that must reach a human, not be auto-included.
try {
  await investigatorAttest({ patientId: "PT-7005" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`investigator inline attest DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
