#!/usr/bin/env node
// Oncology patient access, funding & appeals: a specialty-pharmacy "hub" agent
// works $100k+/yr oncology therapies for under-covered patients — benefits
// investigation, denial reasons, funding stacks across manufacturer copay cards
// and independent charitable foundations (PAN, HealthWell, LLS), and appeal
// letters. All of that is reversible draft/assemble work the agent can do alone.
//
// Two acts carry real legal weight and are barred to the agent acting alone:
// submitting the appeal/prior-auth to the payer (an attestation of medical
// necessity / eligibility) and enrolling a patient into a copay program or
// charitable foundation. Mis-enrollment — e.g. routing a Medicare patient into
// manufacturer copay support — is Anti-Kickback Statute / False Claims Act
// exposure, so a named access specialist or pharmacist must sign before submit
// or enroll.
//
// The control that stops it: the coordinator role holds the low-risk draft
// skills and NO submit/enroll grant (deny-by-default). The submit and enroll
// skills are published high-risk, so even the access-specialist role that holds
// them cannot run them through the bare proxy — they execute only in a governed
// flow with a preceding approval gate where the pharmacist signs.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/oncology-patient-access/demo.mjs
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
const benefitsVerify = await ensureSkill(client, "oncology-benefits-verify@1", {
  description: "Run benefits verification and identify the denial reason; commits nothing",
});
const fundingMatch = await ensureSkill(client, "oncology-funding-match@1", {
  description: "Match an eligible funding stack (copay card + charitable foundation) to the patient's plan type",
});
const appealDraft = await ensureSkill(client, "oncology-appeal-draft@1", {
  description: "Draft a medical-necessity appeal letter for the payer; commits nothing",
});
// Submitting the appeal/prior-auth attests medical necessity to the payer; it is
// consequential and irreversible: high risk tier, refused on the proxy.
const appealSubmit = await ensureSkill(client, "oncology-appeal-submit@1", {
  riskTier: "high",
  description: "Attest medical necessity and SUBMIT the prior-auth / appeal to the payer (irreversible)",
});
// Enrolling a patient into a copay program / charitable foundation is the
// Anti-Kickback / False Claims exposure point: high risk tier, refused on the
// proxy. A named access specialist or pharmacist must sign before it runs.
const foundationEnroll = await ensureSkill(client, "oncology-foundation-enroll@1", {
  riskTier: "high",
  description: "ENROLL the patient into a copay program or charitable foundation (irreversible; AKS/FCA exposure)",
});

// The hub coordinator can verify, match funding, and draft appeals, but holds NO
// submit or enroll grant (deny by default) — it can propose, never commit.
const coordinatorRole = await ensureRole(client, "oncology-hub-access-coordinator", {
  description: "Verifies benefits, matches funding, drafts appeals; cannot submit or enroll a patient.",
});
// The access specialist / pharmacist holds the submit and enroll grants, but the
// skills' high risk tier forces them through an approval gate before they run.
const specialistRole = await ensureRole(client, "oncology-access-specialist-pharmacist", {
  description: "Named signer for submit/enroll, but only through a gated flow.",
});

await ensureGrant(client, coordinatorRole, benefitsVerify);
await ensureGrant(client, coordinatorRole, fundingMatch);
await ensureGrant(client, coordinatorRole, appealDraft);
await ensureGrant(client, specialistRole, appealSubmit);
await ensureGrant(client, specialistRole, foundationEnroll);

await ensureAgent(client, "oncology-hub-access-bot", "oncology-hub-access-coordinator");
await ensureAgent(client, "oncology-access-specialist-bot", "oncology-access-specialist-pharmacist");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "oncology-patient-access-funding-appeal" });
console.log(`proxy session ${session.id} opened\n`);

const verifyBenefits = governedTool(client, session.id, "oncology-hub-access-bot", "oncology-benefits-verify@1", async (i) => ({
  patient: i.patient,
  drug: i.drug,
  planType: i.planType,
  annualCostUsd: i.annualCostUsd,
  denialReason: i.denialReason,
  coverage: "denied",
}));
const matchFunding = governedTool(client, session.id, "oncology-hub-access-bot", "oncology-funding-match@1", async (i) => {
  // Mis-enrollment guardrail (proposal only): manufacturer copay cards are barred
  // for government-insured patients (Medicare/Medicaid) under the Anti-Kickback
  // Statute. The agent surfaces the correct stack but enrolls nothing.
  const govPlan = i.planType === "medicare" || i.planType === "medicaid";
  return {
    patient: i.patient,
    planType: i.planType,
    proposedStack: govPlan
      ? ["charitable_foundation:PAN"]
      : ["copay_card:manufacturer", "charitable_foundation:HealthWell"],
    copayCardEligible: !govPlan,
    note: govPlan
      ? "government plan: manufacturer copay support EXCLUDED (AKS); route to independent foundation only"
      : "commercial plan: copay card permitted",
  };
});
const draftAppeal = governedTool(client, session.id, "oncology-hub-access-bot", "oncology-appeal-draft@1", async (i) => ({
  patient: i.patient,
  drug: i.drug,
  letter: "drafted",
  basis: "medical necessity per NCCN guideline; prior therapy failed",
}));
const coordinatorSubmit = governedTool(client, session.id, "oncology-hub-access-bot", "oncology-appeal-submit@1", async () => {
  throw new Error("unreachable: deny-by-default blocks this");
});
const specialistSubmit = governedTool(client, session.id, "oncology-access-specialist-bot", "oncology-appeal-submit@1", async () => {
  throw new Error("unreachable: high-risk skill is refused on the proxy");
});
const specialistEnroll = governedTool(client, session.id, "oncology-access-specialist-bot", "oncology-foundation-enroll@1", async () => {
  throw new Error("unreachable: high-risk skill is refused on the proxy");
});

// 1. The coordinator verifies benefits and identifies the denial reason — allowed.
console.log("coordinator verifies benefits:", JSON.stringify(await verifyBenefits({
  patient: "PT-7001",
  drug: "Keytruda",
  planType: "commercial",
  annualCostUsd: 235200.0,
  denialReason: "prior_authorization_required",
})));

// 2. The coordinator matches a funding stack — allowed. The Medicare patient is
//    routed to an independent foundation, NOT manufacturer copay support: the
//    mis-enrollment guardrail at the proposal stage.
console.log("coordinator matches funding (commercial):", JSON.stringify(await matchFunding({
  patient: "PT-7001",
  planType: "commercial",
})));
console.log("coordinator matches funding (medicare):", JSON.stringify(await matchFunding({
  patient: "PT-7004",
  planType: "medicare",
})));

// 3. The coordinator drafts the medical-necessity appeal letter — allowed.
console.log("coordinator drafts appeal:", JSON.stringify(await draftAppeal({
  patient: "PT-7001",
  drug: "Keytruda",
})));

// 4. The coordinator tries to SUBMIT the appeal to the payer — denied by default;
//    it holds no submit grant, so the attestation never reaches a tool body. The
//    drafting system cannot file its own appeal.
try {
  await coordinatorSubmit({ patient: "PT-7001", payer: "commercial-PBM" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`coordinator submit DENIED (${err.code}): ${err.reason}`);
}

// 5. Even the access specialist, who holds the submit grant, cannot submit
//    through the proxy: the submit skill is high risk and must run through a
//    governed flow with a preceding approval gate. A named pharmacist signs the
//    medical-necessity attestation at the gate.
try {
  await specialistSubmit({ patient: "PT-7001", payer: "commercial-PBM" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`specialist submit DENIED (${err.code}): ${err.reason}`);
}

// 6. Enrolling the patient into a copay program / charitable foundation is the
//    same way: high risk, refused inline even for the granted specialist. A
//    named human must sign before any enrollment runs — the control that keeps a
//    Medicare patient out of manufacturer copay support (AKS/FCA exposure).
try {
  await specialistEnroll({ patient: "PT-7004", planType: "medicare", program: "manufacturer-copay" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`specialist enroll DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
