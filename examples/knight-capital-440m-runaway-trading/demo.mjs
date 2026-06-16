#!/usr/bin/env node
// Knight Capital (2012): an order-routing system fired millions of unintended
// orders into the market over ~45 minutes with no kill switch, losing ~$440M.
//
// The control that stops it: placing orders is deny-by-default (the router role
// cannot send at all), and the sender role's send skill carries a notional
// ceiling plus a per-session invocation cap — the kill switch the incident lacked.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/knight-capital-440m-runaway-trading/demo.mjs
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
const build = await ensureSkill(client, "order-build@1", { description: "Build an order batch" });
const validate = await ensureSkill(client, "order-validate@1", { description: "Validate an order batch" });
const send = await ensureSkill(client, "order-send@1", { description: "Send orders to the market" });

// order-router builds and validates but holds NO send grant (deny by default).
const routerRole = await ensureRole(client, "order-router", {
  description: "Builds and validates order batches; cannot place orders.",
});
// order-sender may send, but every order is bounded by a notional ceiling and a
// per-session invocation cap — the kill switch Knight Capital did not have.
const senderRole = await ensureRole(client, "order-sender", {
  description: "Places orders within a notional ceiling and an invocation cap.",
  limits: {
    skills: {
      "order-send@1": {
        maxAmountPerInvocation: 1_000_000,
        amountField: "notional",
        maxInvocationsPerRun: 3,
      },
    },
  },
});

await ensureGrant(client, routerRole, build);
await ensureGrant(client, routerRole, validate);
await ensureGrant(client, senderRole, send);

await ensureAgent(client, "order-router-bot", "order-router");
await ensureAgent(client, "order-sender-bot", "order-sender");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "knight-capital-order-routing" });
console.log(`proxy session ${session.id} opened\n`);

const buildBatch = governedTool(client, session.id, "order-router-bot", "order-build@1", async (i) => ({ batch: i.symbol, lots: i.lots }));
const routerSend = governedTool(client, session.id, "order-router-bot", "order-send@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const sendOrder = governedTool(client, session.id, "order-sender-bot", "order-send@1", async (i) => ({ status: "sent", notional: i.notional }));

// 1. The router builds a batch — allowed (it holds the build grant).
console.log("router builds a batch:", JSON.stringify(await buildBatch({ symbol: "ACME", lots: 10 })));

// 2. The router tries to send — denied by default; it has no send grant, so the
//    order never reaches the market. This is the missing kill switch.
try {
  await routerSend({ notional: 500_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`router send DENIED (${err.code}): ${err.reason}`);
}

// 3. The sender places orders within the notional ceiling — allowed.
console.log("sender order $500k:", JSON.stringify(await sendOrder({ notional: 500_000 })));
console.log("sender order $600k:", JSON.stringify(await sendOrder({ notional: 600_000 })));

// 4. A runaway / fat-finger order above the ceiling — denied.
try {
  await sendOrder({ notional: 50_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`runaway $50M order DENIED (${err.code}): ${err.reason}`);
}

// 5. The kill switch: past the invocation cap, further orders are refused even
//    within the ceiling — the runaway stream is stopped.
console.log("sender order $700k:", JSON.stringify(await sendOrder({ notional: 700_000 })));
try {
  await sendOrder({ notional: 800_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`order past the cap DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
