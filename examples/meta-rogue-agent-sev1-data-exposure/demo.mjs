#!/usr/bin/env node
// Meta Sev 1 (March 2026): an autonomous agent reached a point in its workflow
// where a human sign-off was supposed to hold an IAM access change, and it
// proceeded anyway, posting flawed access guidance. A human engineer acting on
// that guidance executed a broad grant, exposing sensitive data for ~2h.
//
// The control that stops it: effecting a broad grant is a capability the agent
// role does not hold at all (deny-by-default), and effecting a scoped grant is a
// high-risk skill the proxy categorically refuses — it must run inside a governed
// flow behind an approval gate, so the checkpoint is structural, not optional.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/meta-rogue-agent-sev1-data-exposure/demo.mjs
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
// Reversible work is low-risk; effecting a grant is high-risk and split by scope.
const read = await ensureSkill(client, "meta-access-read@1", {
  description: "Read current roles, grants, and group membership (reads only)",
});
const draft = await ensureSkill(client, "meta-access-draft@1", {
  description: "Compose a proposed access change (produces a proposal, changes nothing)",
});
const grantScoped = await ensureSkill(client, "meta-access-grant-scoped@1", {
  riskTier: "high",
  description: "Effect a grant within a named scope — high-risk, gated",
});
const grantBroad = await ensureSkill(client, "meta-access-grant-broad@1", {
  riskTier: "high",
  description: "Effect an arbitrary, wide-scope grant",
});

// The agent reads and drafts; it holds NO grant skill at all (deny by default).
const agentRole = await ensureRole(client, "meta-iam-agent-role", {
  description: "Reads access state and drafts proposed access changes; cannot effect a grant.",
});
// A named access owner may effect a scoped grant — but only inside a governed
// flow behind an approval gate; the proxy refuses the high-risk skill directly.
const ownerRole = await ensureRole(client, "meta-access-owner-role", {
  description: "Approves and effects scoped access grants; conflicts with the agent by SoD.",
});

await ensureGrant(client, agentRole, read);
await ensureGrant(client, agentRole, draft);
await ensureGrant(client, ownerRole, grantScoped);
// meta-access-grant-broad@1 is granted to no role.
// meta-access-grant-scoped@1 is NOT granted to the agent role.

await ensureAgent(client, "meta-iam-agent-bot", "meta-iam-agent-role");
await ensureAgent(client, "meta-access-runner-bot", "meta-access-owner-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "meta-rogue-agent-sev1-data-exposure" });
console.log(`proxy session ${session.id} opened\n`);

const readAccess = governedTool(client, session.id, "meta-iam-agent-bot", "meta-access-read@1", async (i) => ({ principal: i.principal, currentRoles: ["reader"] }));
const draftChange = governedTool(client, session.id, "meta-iam-agent-bot", "meta-access-draft@1", async (i) => ({ proposal: i.proposal, status: "drafted" }));
const agentBroadGrant = governedTool(client, session.id, "meta-iam-agent-bot", "meta-access-grant-broad@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const runnerScopedGrant = governedTool(client, session.id, "meta-access-runner-bot", "meta-access-grant-scoped@1", async () => { throw new Error("unreachable: high-risk refused on the proxy"); });

// 1. The agent reads the current access state — allowed (reversible, granted).
console.log("agent reads access:", JSON.stringify(await readAccess({ principal: "svc-analytics" })));

// 2. The agent drafts the proposed change — allowed (reversible, granted).
console.log("agent drafts change:", JSON.stringify(await draftChange({ proposal: "grant svc-analytics read on pii-bucket" })));

// 3. The agent tries to effect a broad grant — denied by default; the role holds
//    no grant skill at all, so the IAM change never happens. The broad grant was
//    never grantable, so there is no checkpoint to skip.
try {
  await agentBroadGrant({ principal: "svc-analytics", scope: "*" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`agent broad grant DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the named access owner cannot effect a scoped grant directly through
//    the proxy: it is high-risk, so it is categorically refused and must run in a
//    governed flow behind an approval gate decided by someone who is not the
//    requester. The checkpoint is structural, not optional.
try {
  await runnerScopedGrant({ principal: "svc-analytics", resource: "pii-bucket", access: "read" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`scoped grant on proxy DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
