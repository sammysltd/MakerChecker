#!/usr/bin/env node
// DN42 cloud bill (May 2026): an AI agent told to scan a hobbyist network
// provisioned five m8g.12xlarge instances plus load balancers and Lambda, then
// redeployed duplicates in a loop, running up a verified $6,531.30 AWS bill in
// ~24 hours under a blanket operator "continue".
//
// The control that stops it: inspecting and tearing down are reversible and run
// pre-gate; provisioning paid compute splits by tier. Over-tier provisioning is
// a skill the scan role never holds (deny-by-default), and within-tier
// provisioning is published high-risk, so the proxy refuses it categorically —
// it must run through a governed flow behind a per-deploy approval gate.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   MAKERCHECKER_URL=http://localhost:3000 node examples/dn42-agent-runaway-aws-cloud-bill/demo.mjs
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
const inspect = await ensureSkill(client, "dn42-cloud-inspect@1", {
  description: "List resources, regions, and current spend; produce a sized plan",
});
const teardown = await ensureSkill(client, "dn42-cloud-teardown@1", {
  description: "Release resources the agent created; reversible toward zero cost",
});
const provisionSmall = await ensureSkill(client, "dn42-cloud-provision-small@1", {
  riskTier: "high",
  description: "Provision small-tier paid compute (one instance, capped class)",
});
const provisionLarge = await ensureSkill(client, "dn42-cloud-provision-large@1", {
  riskTier: "high",
  description: "Provision large-tier paid compute (multiple/large instances)",
});

// scan-agent inspects and tears down freely, but inspection is capped per run.
// It may provision within the small tier only through the gated flow; it holds
// NO grant for large-tier provisioning (deny by default).
const scanRole = await ensureRole(client, "dn42-scan-agent", {
  description: "Scans DN42; inspects and tears down pre-gate, small provision gated only.",
  limits: {
    skills: {
      "dn42-cloud-inspect@1": { maxInvocationsPerRun: 20 },
    },
  },
});
// infra-owner is the only role where large provisioning is a real duty.
const ownerRole = await ensureRole(client, "dn42-infra-owner", {
  description: "Owns infrastructure; large-tier provisioning is a real duty.",
});

await ensureGrant(client, scanRole, inspect);
await ensureGrant(client, scanRole, teardown);
await ensureGrant(client, scanRole, provisionSmall);
await ensureGrant(client, ownerRole, provisionLarge);

await ensureAgent(client, "dn42-scan-bot", "dn42-scan-agent");

// --- Drive the governed agent through the proxy ----------------------------
const { session } = await client.proxy.openSession({ label: "dn42-network-scan-provisioning" });
console.log(`proxy session ${session.id} opened\n`);

const inspectAccount = governedTool(client, session.id, "dn42-scan-bot", "dn42-cloud-inspect@1", async (i) => ({ region: i.region, monthlySpendUsd: 12.4 }));
const provisionLargeBatch = governedTool(client, session.id, "dn42-scan-bot", "dn42-cloud-provision-large@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const provisionSmallDeploy = governedTool(client, session.id, "dn42-scan-bot", "dn42-cloud-provision-small@1", async () => { throw new Error("unreachable: high risk refused on the proxy"); });
const tearDown = governedTool(client, session.id, "dn42-scan-bot", "dn42-cloud-teardown@1", async (i) => ({ released: i.resourceId }));

// 1. The agent inspects the account and current spend — allowed (low risk).
console.log("agent inspects account:", JSON.stringify(await inspectAccount({ region: "eu-central-1" })));

// 2. The agent tries five m8g.12xlarge instances. That is over the granted
//    tier, so the request resolves to the large-provision skill the scan role
//    was never granted — refused before any resource is created. The blanket
//    "continue" does not change the decision; authorization is on the action.
try {
  await provisionLargeBatch({ instanceClass: "m8g.12xlarge", count: 5 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`5x m8g.12xlarge DENIED (${err.code}): ${err.reason}`);
}

// 3. A within-tier deploy travels as the small-provision skill. It is published
//    high-risk, so the proxy refuses it outside a governed flow: each paid
//    deploy must clear a preceding approval gate, not run on the agent's own
//    authority. The redeploy loop meets this gate on every iteration.
try {
  await provisionSmallDeploy({ instanceClass: "m8g.large", count: 1 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`small deploy DENIED (${err.code}): ${err.reason}`);
}

// 4. Tearing down resources is reversible toward zero cost — allowed pre-gate.
console.log("agent tears down:", JSON.stringify(await tearDown({ resourceId: "i-0abc" })));

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
