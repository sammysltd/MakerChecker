#!/usr/bin/env node
// Mata v Avianca (2023): attorneys filed a brief citing six cases ChatGPT had
// fabricated, then submitted fake excerpts when the citations were questioned.
// The drafting actor both wrote the brief and controlled the path that put it
// on a federal docket, with no separate party accountable for the filed version.
//
// The control that stops it: drafting and citation lookup are reversible and
// stay with the drafting role; filing to the docket is the irreversible action.
// The drafter holds no filing grant (deny-by-default), and the filing skill is
// published high-risk so it is categorically refused on the proxy — it must run
// through a governed flow with a preceding approval gate, not as a direct call.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/mata-v-avianca-fabricated-citations-filed/demo.mjs
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
const draft = await ensureSkill(client, "mata-brief-draft@1", {
  description: "Compose and revise a brief; produces a document, files nothing.",
});
const lookup = await ensureSkill(client, "mata-citation-lookup@1", {
  description: "Query the internal case database for candidate authorities.",
});
const file = await ensureSkill(client, "mata-court-file@1", {
  riskTier: "high",
  description: "Submit a specific brief version to the court docket.",
});

// The drafting attorney drafts and looks up citations, but holds NO filing
// grant — the drafter cannot file their own work to the docket.
const draftingRole = await ensureRole(client, "mata-drafting-attorney", {
  description: "Drafts briefs and looks up authorities; cannot file to the docket.",
});
// The supervising attorney is the named actor granted the filing skill. Filing
// is high-risk, so even with the grant it is refused on the proxy and must run
// through a governed flow with a preceding approval gate.
const supervisingRole = await ensureRole(client, "mata-supervising-attorney", {
  description: "Files approved briefs, only through a gated flow.",
});

await ensureGrant(client, draftingRole, draft);
await ensureGrant(client, draftingRole, lookup);
await ensureGrant(client, supervisingRole, file);

await ensureAgent(client, "mata-drafting-bot", "mata-drafting-attorney");
await ensureAgent(client, "mata-supervising-bot", "mata-supervising-attorney");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "mata-v-avianca-court-filing" });
console.log(`proxy session ${session.id} opened\n`);

const draftBrief = governedTool(client, session.id, "mata-drafting-bot", "mata-brief-draft@1", async (i) => ({ brief: i.matter, version: i.version }));
const lookupCites = governedTool(client, session.id, "mata-drafting-bot", "mata-citation-lookup@1", async (i) => ({ query: i.query, hits: 6 }));
const drafterFile = governedTool(client, session.id, "mata-drafting-bot", "mata-court-file@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const supervisorFile = governedTool(client, session.id, "mata-supervising-bot", "mata-court-file@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The drafting agent composes the brief — allowed (it holds the draft grant).
console.log("drafter writes brief:", JSON.stringify(await draftBrief({ matter: "Mata v. Avianca", version: "v3" })));

// 2. The drafting agent looks up authorities — allowed; reversible reads.
console.log("drafter looks up cites:", JSON.stringify(await lookupCites({ query: "tolling Montreal Convention" })));

// 3. The drafter tries to file — denied by default; no filing grant, so the
//    brief never reaches the docket. The drafter cannot file their own work.
try {
  await drafterFile({ briefVersion: "v3" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`drafter file DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the supervising attorney, who holds the grant, cannot file directly
//    through the proxy: the skill is high-risk and must run through a governed
//    flow with a preceding approval gate, not as an ad hoc call.
try {
  await supervisorFile({ briefVersion: "v3" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`supervisor direct file DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
