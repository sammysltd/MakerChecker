#!/usr/bin/env node
// Air Canada (2022): a website chatbot told a customer he could claim a
// retroactive bereavement-fare discount within 90 days. The airline did have a
// bereavement policy, but the real one excluded retroactive claims — the bot
// misstated it. A tribunal (2024 BCCRT 149) found negligent misrepresentation
// and ordered Air Canada to pay $812.02 CAD. The chatbot executed nothing; the
// unreviewed answer alone bound the company. This demo wires up the adjacent
// deployment where the assistant can also commit refunds.
//
// The control that stops it: answering is reversible and ungated; committing a
// refund is not. The support role holds no commit grant at all (deny-by-default).
// A small, standard-policy refund flows through an argument-limited skill bounded
// by an amount ceiling and an allowed-basis list. A commit of any amount or on an
// invented basis is a high-risk skill, categorically refused on the proxy — it
// "must run through a governed flow with a preceding approval gate".
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/air-canada-chatbot-bereavement-refund-binding/demo.mjs
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
// All names are prefixed "aircanada-" to avoid collisions on the shared server.
const answer = await ensureSkill(client, "aircanada-support-answer@1", {
  description: "Answer customer questions and quote published policy. Binds nothing.",
});
const commitCapped = await ensureSkill(client, "aircanada-refund-commit-capped@1", {
  riskTier: "medium",
  description: "Effect a refund within published policy and under a fixed threshold.",
});
const commitOpen = await ensureSkill(client, "aircanada-refund-commit@1", {
  riskTier: "high",
  description: "Commit a refund of any amount or on a non-standard basis.",
});

// support-agent answers questions but holds NO refund-commit grant of any kind:
// the bot cannot bind the airline on its own (deny-by-default).
const supportRole = await ensureRole(client, "aircanada-support-agent", {
  description: "Answers questions and quotes policy; cannot commit a refund.",
});
// refund-officer may issue a capped refund within published policy. The grant on
// the capped skill carries an amount ceiling and an allowlist of valid policy
// bases; the open-amount commit is high-risk and is refused on the proxy.
const officerRole = await ensureRole(client, "aircanada-refund-officer", {
  description: "Issues capped refunds within published policy bases.",
  limits: {
    skills: {
      "aircanada-refund-commit-capped@1": {
        maxAmountPerInvocation: 200,
        amountField: "amountCad",
        allowlist: { field: "policyBasis", values: ["flight-delay", "cancellation", "baggage"] },
      },
    },
  },
});

await ensureGrant(client, supportRole, answer);
await ensureGrant(client, officerRole, commitCapped);
await ensureGrant(client, officerRole, commitOpen);

await ensureAgent(client, "aircanada-support-bot", "aircanada-support-agent");
await ensureAgent(client, "aircanada-refund-officer-bot", "aircanada-refund-officer");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "air-canada-bereavement-refund" });
console.log(`proxy session ${session.id} opened\n`);

const botAnswer = governedTool(client, session.id, "aircanada-support-bot", "aircanada-support-answer@1", async (i) => ({ reply: i.reply }));
const botCommit = governedTool(client, session.id, "aircanada-support-bot", "aircanada-refund-commit@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const officerCapped = governedTool(client, session.id, "aircanada-refund-officer-bot", "aircanada-refund-commit-capped@1", async (i) => ({ status: "refunded", amountCad: i.amountCad, basis: i.policyBasis }));
const officerOpen = governedTool(client, session.id, "aircanada-refund-officer-bot", "aircanada-refund-commit@1", async (i) => ({ status: "refunded", amountCad: i.amountCad }));

// 1. The bot answers the customer — even with the fabricated bereavement claim.
//    That text binds nothing; answering is its job.
console.log("bot answers:", JSON.stringify(await botAnswer({
  reply: "You can claim the bereavement discount retroactively within 90 days.",
})));

// 2. The bot tries to commit the invented refund — denied by default. The support
//    role holds no commit grant, so the obligation never attaches to the airline.
try {
  await botCommit({ amountCad: 812, policyBasis: "retroactive-bereavement" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`bot refund commit DENIED (${err.code}): ${err.reason}`);
}

// 3. A standard-policy refund within the threshold and on an allowed basis —
//    the officer issues it without a gate.
console.log("officer refunds CAD 150 (cancellation):", JSON.stringify(await officerCapped({ amountCad: 150, policyBasis: "cancellation" })));

// 4. The invented basis is not on the allowlist — refused at the skill boundary.
try {
  await officerCapped({ amountCad: 150, policyBasis: "retroactive-bereavement" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`invented-basis refund DENIED (${err.code}): ${err.reason}`);
}

// 5. An amount over the threshold — refused even on a valid basis (fail closed).
try {
  await officerCapped({ amountCad: 812, policyBasis: "cancellation" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`over-threshold refund DENIED (${err.code}): ${err.reason}`);
}

// 6. The open-amount commit is high-risk: the proxy refuses it categorically. A
//    refund of any amount or on a non-standard basis must run through a governed
//    flow with a preceding approval gate, decided by a named officer.
try {
  await officerOpen({ amountCad: 812, policyBasis: "retroactive-bereavement" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`open refund commit DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
