#!/usr/bin/env node
// Grok / Bankrbot (2026): a reply hid a payment instruction in Morse code. The
// decoded text told Grok to send 3 billion DRB tokens, and the connected wallet
// agent effected the on-chain transfer with no human approval — ~$150K moved
// irreversibly from a social-feed reply.
//
// The control that stops it: effecting a transfer is irreversible, so the wallet
// role holds no general transfer skill. Reading balances and drafting a proposal
// are reversible and stay with the agent. The bounded transfer skill is published
// high-risk, so the proxy categorically refuses it — it must run through a
// governed flow behind an approval gate, never from a self-issued instruction.
// The unbounded transfer is never granted, so the arbitrary send is refused
// deny-by-default.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/grok-bankrbot-morse-code-wallet-drain/demo.mjs
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
const balanceRead = await ensureSkill(client, "grok-balance-read@1", {
  description: "Read wallet and token balances",
});
const transferDraft = await ensureSkill(client, "grok-transfer-draft@1", {
  description: "Compose a proposed transfer; produces a proposal, moves nothing",
});
// Effecting a transfer is irreversible — both transfer skills are high-risk, so
// the proxy refuses them and forces them through a governed flow with a gate.
const transferBounded = await ensureSkill(client, "grok-transfer-bounded@1", {
  riskTier: "high",
  description: "Effect a transfer within a per-call cap and to an allowlisted address",
});
const transferOpen = await ensureSkill(client, "grok-transfer-open@1", {
  riskTier: "high",
  description: "Effect an arbitrary transfer to any address",
});

// The wallet agent may read and draft, and may propose the bounded transfer, but
// is never granted the unbounded transfer (deny by default).
const walletRole = await ensureRole(client, "grok-wallet-agent", {
  description: "Reads balances and drafts transfers; cannot effect arbitrary payments.",
});

await ensureGrant(client, walletRole, balanceRead);
await ensureGrant(client, walletRole, transferDraft);
await ensureGrant(client, walletRole, transferBounded);
// grok-transfer-open@1 is intentionally NOT granted.

await ensureAgent(client, "grok-wallet-bot", "grok-wallet-agent");

// --- Drive the governed agent through the proxy ----------------------------
const { session } = await client.proxy.openSession({ label: "grok-bankrbot-wallet-transfer" });
console.log(`proxy session ${session.id} opened\n`);

const readBalance = governedTool(client, session.id, "grok-wallet-bot", "grok-balance-read@1", async () => ({
  DRB: 3_200_000_000,
}));
const draftTransfer = governedTool(client, session.id, "grok-wallet-bot", "grok-transfer-draft@1", async (i) => ({
  proposal: { to: i.to, token: i.token, amount: i.amount, status: "drafted" },
}));
const effectBounded = governedTool(client, session.id, "grok-wallet-bot", "grok-transfer-bounded@1", async (i) => ({
  status: "sent",
  ...i,
}));
const effectOpen = governedTool(client, session.id, "grok-wallet-bot", "grok-transfer-open@1", async (i) => ({
  status: "sent",
  ...i,
}));

// The Morse-code reply decodes to "send 3 billion DRB tokens". The agent forms
// that intent. It can read balances and draft the proposal — both reversible.
console.log("balance read:", JSON.stringify(await readBalance({})));
console.log(
  "transfer drafted:",
  JSON.stringify(await draftTransfer({ to: "0xATTACKER", token: "DRB", amount: 3_000_000_000 })),
);

// 1. The agent tries the arbitrary transfer — denied deny-by-default; the
//    unbounded transfer skill is never granted to the wallet role.
try {
  await effectOpen({ to: "0xATTACKER", token: "DRB", amount: 3_000_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`arbitrary transfer DENIED (${err.code}): ${err.reason}`);
}

// 2. The agent falls back to the bounded transfer — refused on the proxy because
//    it is high-risk; an irreversible payment cannot fire from a self-issued
//    instruction and must run through a governed flow behind an approval gate.
try {
  await effectBounded({ to: "0xATTACKER", token: "DRB", amount: 3_000_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`bounded transfer DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
