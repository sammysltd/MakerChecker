#!/usr/bin/env node
// Claude Code (2026): after a rejected push and a failed rebase, a coding agent
// ran `git push --force` and overwrote a private repo's full history down to a
// single commit, without asking.
//
// The control that stops it: ordinary version control (clone, status, diff,
// commit, fast-forward push) is a low-risk skill the coding role holds and runs
// freely. Rewriting remote history is a separate, high-risk skill the coding
// role is NOT granted (deny by default), and which the proxy categorically
// refuses outside a governed flow with a preceding approval gate.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/claude-code-force-push-destroyed-git-history/demo.mjs
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
const vcs = await ensureSkill(client, "cc-git-vcs@1", {
  description: "Clone, status, diff, commit, fast-forward push. No history rewriting.",
});
// Rewriting remote history is high-risk: the proxy refuses it outside a governed
// flow whose preceding approval gate a named repo owner decides.
const forcePush = await ensureSkill(client, "cc-git-force-push@1", {
  riskTier: "high",
  description: "Rewrite a remote branch's history via force-push.",
});

// coding-agent does ordinary version control and holds NO force-push grant.
const codingRole = await ensureRole(client, "cc-coding-agent", {
  description: "Runs ordinary version control; cannot rewrite remote history.",
});
// repo-owner is the named human who can authorize a force-push, and only through
// the gated flow — never ad hoc on the proxy.
const ownerRole = await ensureRole(client, "cc-repo-owner", {
  description: "Authorizes reviewed history rewrites through a gated flow.",
});

await ensureGrant(client, codingRole, vcs);
await ensureGrant(client, ownerRole, forcePush);

await ensureAgent(client, "cc-coding-bot", "cc-coding-agent");
await ensureAgent(client, "cc-repo-owner-bot", "cc-repo-owner");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "claude-code-force-push" });
console.log(`proxy session ${session.id} opened\n`);

const commit = governedTool(client, session.id, "cc-coding-bot", "cc-git-vcs@1", async (i) => ({ ran: i.cmd }));
const codingForcePush = governedTool(client, session.id, "cc-coding-bot", "cc-git-force-push@1", async () => {
  throw new Error("unreachable: deny-by-default blocks this");
});
const ownerForcePush = governedTool(client, session.id, "cc-repo-owner-bot", "cc-git-force-push@1", async () => {
  throw new Error("unreachable: high-risk skill is refused on the proxy");
});

// 1. The agent does ordinary version control — allowed (it holds the vcs grant).
console.log("commit:", JSON.stringify(await commit({ cmd: "git commit -m 'wip'" })));
console.log("fast-forward push:", JSON.stringify(await commit({ cmd: "git push" })));

// 2. After the rejected push and failed rebase, the agent reaches for force-push.
//    The coding role holds no such grant, so deny-by-default refuses it before
//    any git remote is touched. The reasoning that led here is irrelevant.
try {
  await codingForcePush({ branch: "main" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`coding force-push DENIED (${err.code}): ${err.reason}`);
}

// 3. Even the repo owner, who holds the grant, cannot force-push ad hoc on the
//    proxy: the skill is high-risk, so it is categorically refused and must run
//    through a governed flow with a preceding approval gate.
try {
  await ownerForcePush({ branch: "main" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`owner ad-hoc force-push DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
