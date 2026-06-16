#!/usr/bin/env node
// Cigna PxDx (2022): a claims system produced denials that company doctors
// signed off in batches at ~1.2 seconds each without reading the individual
// claims — a human step that existed on paper while reviewing nothing.
//
// The control that stops it: assessing a claim and assembling the file are
// reversible and granted to the assessor; committing a denial is the
// irreversible step, published as a high-risk skill. The assessor holds no
// commit grant (deny-by-default), and the high-risk commit skill is
// categorically refused on the proxy — it cannot run inline, only through a
// governed flow with a preceding approval gate.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/cigna-pxdx-batch-rubber-stamp-denials/demo.mjs
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
const assess = await ensureSkill(client, "cigna-coverage-assess@1", {
  description: "Evaluate the request against policy and produce a recommendation; commits nothing",
});
const buildFile = await ensureSkill(client, "cigna-claim-file-build@1", {
  description: "Assemble the claim record and the basis for the recommendation",
});
const commit = await ensureSkill(client, "cigna-coverage-deny-commit@1", {
  riskTier: "high",
  description: "Finalize a denial against the member's benefit (irreversible)",
});

// claims-assessor assesses and assembles the file but holds NO commit grant.
const assessorRole = await ensureRole(client, "cigna-claims-assessor", {
  description: "Evaluates claims and assembles files; cannot finalize a denial.",
});
// medical-reviewer holds the commit grant, but the commit skill is high-risk,
// so even a granted role cannot run it inline — it must pass an approval gate.
const reviewerRole = await ensureRole(client, "cigna-medical-reviewer", {
  description: "Finalizes denials only through a governed flow with an approval gate.",
});

await ensureGrant(client, assessorRole, assess);
await ensureGrant(client, assessorRole, buildFile);
await ensureGrant(client, reviewerRole, commit);

await ensureAgent(client, "cigna-assessor-bot", "cigna-claims-assessor");
await ensureAgent(client, "cigna-reviewer-bot", "cigna-medical-reviewer");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "cigna-pxdx-claim-decision" });
console.log(`proxy session ${session.id} opened\n`);

const assessClaim = governedTool(client, session.id, "cigna-assessor-bot", "cigna-coverage-assess@1", async (i) => ({ claim: i.claimId, recommendation: "deny", basis: i.basis }));
const buildClaimFile = governedTool(client, session.id, "cigna-assessor-bot", "cigna-claim-file-build@1", async (i) => ({ claim: i.claimId, file: "assembled" }));
const assessorCommit = governedTool(client, session.id, "cigna-assessor-bot", "cigna-coverage-deny-commit@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const reviewerCommit = governedTool(client, session.id, "cigna-reviewer-bot", "cigna-coverage-deny-commit@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The assessor evaluates the claim — allowed (it holds the assess grant).
console.log("assessor evaluates claim:", JSON.stringify(await assessClaim({ claimId: "C-1001", basis: "not medically necessary" })));

// 2. The assessor assembles the claim file — allowed (reversible, granted).
console.log("assessor builds claim file:", JSON.stringify(await buildClaimFile({ claimId: "C-1001" })));

// 3. The assessor tries to commit the denial — denied by default; the assessing
//    role holds no commit grant, so the denial never reaches a tool body.
try {
  await assessorCommit({ claimId: "C-1001" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`assessor commit DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the granted reviewer cannot commit inline: the commit skill is
//    high-risk, categorically refused on the proxy. A denial only proceeds
//    through the governed flow, where it parks at the medical-review gate.
try {
  await reviewerCommit({ claimId: "C-1001" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`reviewer inline commit DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
