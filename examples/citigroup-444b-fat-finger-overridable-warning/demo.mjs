#!/usr/bin/env node
// Citigroup (2022): a trader meant to sell a $58M basket and built one of $444B,
// clicking through a single pop-up listing 711 warning messages (only the first
// 18 visible without scrolling) on the way to release. ~$1.4B sold before
// cancellation, briefly crashing the OMX Stockholm 30. The warnings were
// overridable; nothing was a hard block. FCA/PRA fined Citigroup £61.6M.
//
// The control that stops it: submission is split by notional. The capped submit
// skill carries a hard per-invocation notional ceiling — a $444B basket is over
// the ceiling and is refused at the proxy, with no pop-up to dismiss. The only
// over-cap path is an uncapped submit skill that the execution role does not
// hold and that is risk_tier high, so it cannot run on the proxy at all without
// a preceding approval gate. The clicked-away pop-up of 711 warnings becomes a
// non-bypassable gate.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/citigroup-444b-fat-finger-overridable-warning/demo.mjs
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
const stage = await ensureSkill(client, "citi-basket-stage@1", {
  description: "Assemble, price, and validate a basket order (reversible, pre-gate)",
});
const submitCapped = await ensureSkill(client, "citi-trade-submit-capped@2", {
  description: "Submit a staged basket to the algo, bounded to a hard role notional ceiling",
});
const submitUncapped = await ensureSkill(client, "citi-trade-submit-uncapped@1", {
  riskTier: "high",
  description: "Release an over-cap basket; only reachable past an approval gate",
});

// The execution role stages freely and may submit only at or below a hard
// notional ceiling. It also "holds" the uncapped release skill so the proxy can
// demonstrate the categorical high-risk refusal rather than a deny-by-default —
// either way the over-cap release cannot run on the agent's own authority.
const executionRole = await ensureRole(client, "citi-execution-agent-v2", {
  description: "Stages and prices baskets; submits only within a notional ceiling.",
  limits: {
    skills: {
      "citi-trade-submit-capped@2": {
        maxAmountPerInvocation: 1_000_000_000,
        amountField: "notional",
      },
    },
  },
});
// The desk head is the only role that can release an over-cap basket, and only
// past the gate. Modeled here for completeness; the proxy refuses the high-risk
// skill categorically without a governed flow + gate.
const deskHeadRole = await ensureRole(client, "citi-desk-head", {
  description: "Releases over-cap baskets past a desk-head approval gate.",
});

await ensureGrant(client, executionRole, stage);
await ensureGrant(client, executionRole, submitCapped);
await ensureGrant(client, executionRole, submitUncapped);
await ensureGrant(client, deskHeadRole, submitUncapped);

await ensureAgent(client, "citi-execution-bot-v2", "citi-execution-agent-v2");

// --- Drive the governed agent through the proxy ----------------------------
const { session } = await client.proxy.openSession({ label: "citigroup-basket-order-submission" });
console.log(`proxy session ${session.id} opened\n`);

const stageBasket = governedTool(client, session.id, "citi-execution-bot-v2", "citi-basket-stage@1", async (i) => ({ staged: true, notional: i.notional }));
const submitOrder = governedTool(client, session.id, "citi-execution-bot-v2", "citi-trade-submit-capped@2", async (i) => ({ status: "submitted", notional: i.notional }));
const releaseUncapped = governedTool(client, session.id, "citi-execution-bot-v2", "citi-trade-submit-uncapped@1", async () => { throw new Error("unreachable: high-risk skill is refused on the proxy"); });

// 1. The agent stages the intended $58M basket — allowed (staging is reversible).
console.log("stage $58M basket:", JSON.stringify(await stageBasket({ notional: 58_000_000 })));

// 2. The intended order submits within the notional ceiling — allowed.
console.log("submit $58M basket:", JSON.stringify(await submitOrder({ notional: 58_000_000 })));

// 3. The fat-finger $444B basket is over the ceiling — refused at the proxy.
//    There is no pop-up to dismiss and no override on the agent side.
try {
  await submitOrder({ notional: 444_000_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`fat-finger $444B submit DENIED (${err.code}): ${err.reason}`);
}

// 4. The only over-cap release path is the uncapped submit skill, which is high
//    risk. Even with the grant the proxy refuses it outright: it must run through
//    a governed flow with a preceding approval gate. The pop-up of 711 warnings
//    the trader clicked away becomes a gate that cannot be dismissed.
try {
  await releaseUncapped({ notional: 444_000_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`over-cap release DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
