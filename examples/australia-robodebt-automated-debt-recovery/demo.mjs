#!/usr/bin/env node
// Robodebt (Australia, 2015-2019): an automated income-averaging system raised
// welfare debts and issued the debt notices itself, after the human review that
// had checked each determination was removed from the path. About A$1.76bn in
// debts was unlawfully raised against more than 433,000 people; the ~A$751M
// actually recovered was later repaid under a Federal Court settlement.
//
// The control that stops it: issuing a notice is a one-way door. The system that
// calculates a debt cannot issue it (deny-by-default), and issuance is modeled as
// a high-risk skill, which the proxy categorically refuses — it must run through a
// governed flow with a preceding approval gate for a named officer.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/australia-robodebt-automated-debt-recovery/demo.mjs
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
// Calculating a debt and staging the proposed notice is reversible -> low risk.
const calculate = await ensureSkill(client, "robodebt-debt-calculate@1", {
  riskTier: "low",
  description: "Calculate a debt from income data and stage the proposed notice",
});
// Issuing a notice commits a debt against a named citizen and starts recovery:
// a one-way door -> high risk, which the proxy refuses without a gate.
const issue = await ensureSkill(client, "robodebt-debt-issue@1", {
  riskTier: "high",
  description: "Issue the debt notice and start recovery (one-way door)",
});

// The calculator computes the debt but holds NO issue grant (deny by default):
// the system that produced the figure cannot also commit it.
const calculatorRole = await ensureRole(client, "robodebt-debt-calculator", {
  description: "Calculates debts and stages proposed notices; cannot issue.",
});
// The issuer role holds the issue grant, but the skill is high-risk, so the
// proxy refuses it outright: issuance can only travel through a governed flow
// with a preceding approval gate for a named review officer.
const issuerRole = await ensureRole(client, "robodebt-notice-issuer", {
  description: "Issues notices only via a governed flow behind an approval gate.",
});

await ensureGrant(client, calculatorRole, calculate);
await ensureGrant(client, issuerRole, issue);

await ensureAgent(client, "robodebt-calculator-bot", "robodebt-debt-calculator");
await ensureAgent(client, "robodebt-issuer-bot", "robodebt-notice-issuer");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "robodebt-debt-determination" });
console.log(`proxy session ${session.id} opened\n`);

const stageDebt = governedTool(client, session.id, "robodebt-calculator-bot", "robodebt-debt-calculate@1", async (i) => ({
  status: "staged",
  citizen: i.citizen,
  proposedDebt: i.proposedDebt,
}));
const calculatorIssues = governedTool(client, session.id, "robodebt-calculator-bot", "robodebt-debt-issue@1", async () => {
  throw new Error("unreachable: deny-by-default blocks this");
});
const issuerIssues = governedTool(client, session.id, "robodebt-issuer-bot", "robodebt-debt-issue@1", async () => {
  throw new Error("unreachable: high-risk is refused on the proxy");
});

// 1. The calculator stages a proposed notice pre-gate — allowed (reversible).
console.log("calculator stages a proposed notice:", JSON.stringify(await stageDebt({ citizen: "AX-4471", proposedDebt: 3120.5 })));

// 2. The calculator tries to issue the notice itself — denied by default; it
//    holds no issue grant, so the call never reaches a tool body. This is the
//    human review Robodebt removed from the path.
try {
  await calculatorIssues({ citizen: "AX-4471", amount: 3120.5 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`calculator issue DENIED (${err.code}): ${err.reason}`);
}

// 3. The issuer holds the grant, but issuance is a one-way door (high risk): the
//    proxy refuses it outright. A notice can only proceed through the governed
//    flow, where it parks at an approval gate for a named review officer.
try {
  await issuerIssues({ citizen: "AX-4471", amount: 3120.5 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`direct issue DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
