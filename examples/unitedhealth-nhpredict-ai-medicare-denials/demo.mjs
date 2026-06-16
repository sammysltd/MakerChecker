#!/usr/bin/env node
// UnitedHealth / nH Predict (2023-): a coverage-decision model is alleged to have
// committed post-acute care denials against Medicare Advantage members at a ~90%
// reversal rate, with no named clinician signing each denial and no record of who
// approved it on what basis.
//
// The control that stops it: producing a recommendation and assembling the case
// file are reversible and granted to the assessing role. Committing the denial is
// the irreversible step — it is modeled as a high-risk skill, which the proxy
// refuses outside a governed flow with a preceding approval gate. The assessing
// role never holds the commit skill at all, so deny-by-default refuses it too.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/unitedhealth-nhpredict-ai-medicare-denials/demo.mjs
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
const assess = await ensureSkill(client, "uhc-coverage-assess@1", {
  description: "Evaluate a post-acute coverage request and produce a recommendation",
});
const caseFile = await ensureSkill(client, "uhc-case-file-build@1", {
  description: "Assemble the clinical record and the basis for the recommendation",
});
// Committing a denial is irreversible and consequential: high risk tier, so the
// proxy categorically refuses it outside a governed flow with an approval gate.
const commit = await ensureSkill(client, "uhc-coverage-deny-commit@1", {
  riskTier: "high",
  description: "Finalize a denial against the member's benefit",
});

// The assessing role can recommend and assemble a case file but holds NO commit
// grant (deny by default) — it can propose, never finalize.
const assessorRole = await ensureRole(client, "uhc-coverage-assessor", {
  description: "Assesses coverage and assembles the case file; cannot finalize a denial.",
});
// A clinician reviewer holds the commit grant, but the skill's high risk tier
// forces the denial through an approval gate before it can execute.
const reviewerRole = await ensureRole(client, "uhc-clinician-reviewer", {
  description: "Reviews and commits denials, but only through a gated flow.",
});

await ensureGrant(client, assessorRole, assess);
await ensureGrant(client, assessorRole, caseFile);
await ensureGrant(client, reviewerRole, commit);

await ensureAgent(client, "uhc-assessor-bot", "uhc-coverage-assessor");
await ensureAgent(client, "uhc-reviewer-bot", "uhc-clinician-reviewer");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "unitedhealth-nhpredict-coverage-decision" });
console.log(`proxy session ${session.id} opened\n`);

const runAssess = governedTool(client, session.id, "uhc-assessor-bot", "uhc-coverage-assess@1", async (i) => ({
  member: i.member,
  recommendation: "deny",
  reversalRateClass: "high",
}));
const buildCaseFile = governedTool(client, session.id, "uhc-assessor-bot", "uhc-case-file-build@1", async (i) => ({
  member: i.member,
  caseFile: "assembled",
}));
const assessorCommit = governedTool(client, session.id, "uhc-assessor-bot", "uhc-coverage-deny-commit@1", async () => {
  throw new Error("unreachable: deny-by-default blocks this");
});
const reviewerCommit = governedTool(client, session.id, "uhc-reviewer-bot", "uhc-coverage-deny-commit@1", async () => {
  throw new Error("unreachable: high-risk skill is refused on the proxy");
});

// 1. The assessor evaluates the request and assembles the case file — allowed.
console.log("assessor evaluates:", JSON.stringify(await runAssess({ member: "M-4471" })));
console.log("assessor builds case file:", JSON.stringify(await buildCaseFile({ member: "M-4471" })));

// 2. The assessor tries to finalize the denial — denied by default; it holds no
//    commit grant, so the denial never reaches a tool body. The proposing system
//    cannot finalize its own recommendation.
try {
  await assessorCommit({ member: "M-4471", basis: "nH Predict recommendation" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`assessor commit DENIED (${err.code}): ${err.reason}`);
}

// 3. Even the clinician-reviewer, who holds the grant, cannot commit through the
//    proxy: the commit skill is high risk and must run through a governed flow
//    with a preceding approval gate. A named clinician must sign at the gate.
try {
  await reviewerCommit({ member: "M-4471", basis: "reviewed and denied" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`reviewer commit DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
