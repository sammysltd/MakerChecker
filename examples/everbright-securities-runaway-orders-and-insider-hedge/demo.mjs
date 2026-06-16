#!/usr/bin/env node
// Everbright Securities (2013): an arbitrage system fired ~23.4 billion yuan in
// erroneous buy orders, of which ~7.27 billion filled, spiking the index. Before
// disclosing the error, the same desk hedged its exposure on the non-public
// information. The CSRC fined the firm 523M yuan for insider trading.
//
// Two controls, two failure modes. (1) Runaway orders: staging a batch is
// reversible and granted; submitting is bounded by a notional ceiling, and the
// over-cap escape skill is not granted to the arbitrage role at all. (2) The
// cover trade: drafting a hedge is reversible and granted; effecting it is a
// high-risk one-way door that the proxy refuses categorically — it must run
// through a governed flow behind an approval gate, not on the desk's own
// authority.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/everbright-securities-runaway-orders-and-insider-hedge/demo.mjs
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
const arbStage = await ensureSkill(client, "ebsec-arb-stage@1", { description: "Assemble and validate an arbitrage batch (reversible)" });
const arbSubmitCapped = await ensureSkill(client, "ebsec-arb-submit-capped@1", { description: "Submit an arbitrage batch within the role notional cap" });
const arbSubmitUncapped = await ensureSkill(client, "ebsec-arb-submit-uncapped@1", { riskTier: "high", description: "Release an over-cap order stream (gated escape hatch)" });
const hedgeDraft = await ensureSkill(client, "ebsec-hedge-draft@1", { description: "Draft a proposed hedge against current exposure (reversible)" });
const hedgeSubmit = await ensureSkill(client, "ebsec-hedge-submit@1", { riskTier: "high", description: "Effect a hedge trade (one-way door)" });

// The arbitrage role stages and submits within a cap. It does NOT hold the
// uncapped release skill — the only path to an over-cap stream is a skill it
// cannot call, which a governed flow forces through an approval gate.
const arbRole = await ensureRole(client, "ebsec-arbitrage-agent", {
  description: "Stages batches and submits within a notional cap; cannot release over-cap streams.",
  limits: {
    skills: {
      "ebsec-arb-submit-capped@1": {
        maxAmountPerInvocation: 1_000_000_000,
        amountField: "notional",
      },
    },
  },
});

// The hedging role drafts a hedge but cannot effect one through the proxy: the
// submit skill is high risk and is categorically refused, so the cover trade can
// only travel as a gated request an independent approver must release.
const hedgeRole = await ensureRole(client, "ebsec-hedging-agent", {
  description: "Drafts hedges; effecting a hedge is high risk and must pass an approval gate.",
});

await ensureGrant(client, arbRole, arbStage);
await ensureGrant(client, arbRole, arbSubmitCapped);
await ensureGrant(client, hedgeRole, hedgeDraft);
await ensureGrant(client, hedgeRole, hedgeSubmit);

await ensureAgent(client, "ebsec-arbitrage-bot", "ebsec-arbitrage-agent");
await ensureAgent(client, "ebsec-hedging-bot", "ebsec-hedging-agent");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "ebsec-runaway-orders-and-insider-hedge" });
console.log(`proxy session ${session.id} opened\n`);

const stageBatch = governedTool(client, session.id, "ebsec-arbitrage-bot", "ebsec-arb-stage@1", async (i) => ({ staged: true, notional: i.notional }));
const submitCapped = governedTool(client, session.id, "ebsec-arbitrage-bot", "ebsec-arb-submit-capped@1", async (i) => ({ status: "submitted", notional: i.notional }));
const releaseUncapped = governedTool(client, session.id, "ebsec-arbitrage-bot", "ebsec-arb-submit-uncapped@1", async () => { throw new Error("unreachable: not granted to the arbitrage role"); });
const draftHedge = governedTool(client, session.id, "ebsec-hedging-bot", "ebsec-hedge-draft@1", async (i) => ({ drafted: true, instrument: i.instrument }));
const effectHedge = governedTool(client, session.id, "ebsec-hedging-bot", "ebsec-hedge-submit@1", async () => { throw new Error("unreachable: high-risk submit refused on the proxy"); });

// 1. The arbitrage agent stages a batch — allowed (reversible, granted).
console.log("arb stages batch:", JSON.stringify(await stageBatch({ notional: 500_000_000 })));

// 2. A normal submit within the notional cap — allowed.
console.log("arb submits 500M yuan:", JSON.stringify(await submitCapped({ notional: 500_000_000 })));

// 3. The 23.4 billion yuan erroneous stream — over the cap, refused, no override.
try {
  await submitCapped({ notional: 23_400_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`runaway 23.4B yuan stream DENIED (${err.code}): ${err.reason}`);
}

// 4. The only escape is the uncapped release skill — not granted to this role.
try {
  await releaseUncapped({ notional: 23_400_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`uncapped release DENIED (${err.code}): ${err.reason}`);
}

// 5. After the error, the hedging agent drafts a cover trade — allowed pre-gate.
console.log("hedge drafted:", JSON.stringify(await draftHedge({ instrument: "index-futures" })));

// 6. Effecting the hedge on undisclosed exposure — high risk, refused on the
//    proxy. The cover trade cannot run on the desk's own authority; it must go
//    through a governed flow with a preceding approval gate.
try {
  await effectHedge({ instrument: "index-futures", direction: "short" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`hedge effect DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
