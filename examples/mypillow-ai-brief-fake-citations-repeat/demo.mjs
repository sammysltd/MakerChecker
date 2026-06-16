#!/usr/bin/env node
// MyPillow brief (2025-2026): attorneys filed a motion with ~30 AI-fabricated
// citations, were sanctioned, and then filed again with another bad citation.
// Drafting is reversible; filing with the court is not, and the gate has to fire
// on every submission — the repeat offense is the part to govern directly.
//
// The control that stops it: filing is deny-by-default (the author role holds no
// filing skill), and submission is published as a high-risk skill, so the proxy
// categorically refuses it outside a governed flow with a preceding approval
// gate — the named-attorney sign-off the second filing rode past.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/mypillow-ai-brief-fake-citations-repeat/demo.mjs
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
const draft = await ensureSkill(client, "mypillow-brief-draft@1", {
  description: "Compose or revise the motion; produces a draft, files nothing.",
});
const verify = await ensureSkill(client, "mypillow-cite-verify@1", {
  description: "Check each citation against an authority source for a draft version.",
});
const fileVerified = await ensureSkill(client, "mypillow-court-file-verified@1", {
  riskTier: "high",
  description: "Submit a verified draft version to the court (requires the gate).",
});
const fileOpen = await ensureSkill(client, "mypillow-court-file-open@1", {
  riskTier: "high",
  description: "Submit an arbitrary filing; in the catalog but granted to no role.",
});

// The author drafts and verifies, but holds NO filing grant (deny by default).
const authorRole = await ensureRole(client, "mypillow-brief-author", {
  description: "Drafts the motion and runs citation verification; cannot file.",
});
// The supervising attorney's filing skill is high-risk, so the proxy refuses it
// outside a governed flow with a preceding approval gate.
const attorneyRole = await ensureRole(client, "mypillow-supervising-attorney", {
  description: "Holds the high-risk submission skill; filing must run through a gate.",
});

await ensureGrant(client, authorRole, draft);
await ensureGrant(client, authorRole, verify);
await ensureGrant(client, attorneyRole, fileVerified);
// mypillow-court-file-open@1 is granted to no role on purpose.

await ensureAgent(client, "mypillow-brief-author-bot", "mypillow-brief-author");
await ensureAgent(client, "mypillow-supervising-attorney-bot", "mypillow-supervising-attorney");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "mypillow-court-filing" });
console.log(`proxy session ${session.id} opened\n`);

const draftBrief = governedTool(client, session.id, "mypillow-brief-author-bot", "mypillow-brief-draft@1", async (i) => ({ draftVersion: i.version, body: `motion v${i.version}` }));
const verifyCites = governedTool(client, session.id, "mypillow-brief-author-bot", "mypillow-cite-verify@1", async (i) => ({ draftVersion: i.version, fabricated: i.fabricated ?? 0, passed: (i.fabricated ?? 0) === 0 }));
const authorFileOpen = governedTool(client, session.id, "mypillow-brief-author-bot", "mypillow-court-file-open@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const attorneyFile = governedTool(client, session.id, "mypillow-supervising-attorney-bot", "mypillow-court-file-verified@1", async (i) => ({ filed: i.version }));

// 1. The author drafts the motion — allowed (it holds the draft grant).
console.log("author drafts v1:", JSON.stringify(await draftBrief({ version: 1 })));

// 2. The author runs verification — allowed; it surfaces the fabricated cites.
console.log("author verifies v1:", JSON.stringify(await verifyCites({ version: 1, fabricated: 30 })));

// 3. The author tries to self-file the unbounded skill — denied by default; it
//    holds no filing grant, so the draft is never submitted on its own authority.
try {
  await authorFileOpen({ version: 1 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`author self-file DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the supervising attorney's verified-submission skill is refused on the
//    proxy: it is high-risk, so it must run through a governed flow behind an
//    approval gate — the named-attorney sign-off the second filing rode past.
try {
  await attorneyFile({ version: 1 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`direct submission DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
