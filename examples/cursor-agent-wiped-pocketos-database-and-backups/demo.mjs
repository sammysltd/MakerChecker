#!/usr/bin/env node
// PocketOS (2026): a Cursor agent on a staging task found a root Railway token
// scoped for domain work but carrying blanket rights, and ran one volumeDelete
// that destroyed the production database and its co-located backups in ~9s.
//
// The control that stops it: MakerChecker authorizes the ACTION, not the
// credential. The staging role holds only safe, reversible skills; irreversible
// volume deletion is a separate skill it does not hold (deny by default), so the
// call is refused even while the agent is holding the token. Where deletion is a
// real duty it is published high-risk, which the proxy refuses categorically —
// it must run through a governed flow behind an approval gate. A scoped staging
// deletion skill carries a path limit so it can never reach a production volume.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/cursor-agent-wiped-pocketos-database-and-backups/demo.mjs
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
// Skills are prefixed "pocketos-" to avoid collision on the shared server.
const read = await ensureSkill(client, "pocketos-infra-read@1", {
  description: "List services, volumes, and deploy state",
});
const snapshot = await ensureSkill(client, "pocketos-db-snapshot@1", {
  description: "Take a backup snapshot; the safe direction, runs pre-gate",
});
// Irreversible production deletion is published high-risk so the proxy refuses
// it categorically: it must run inside a governed flow behind an approval gate.
const volumeDelete = await ensureSkill(client, "pocketos-infra-volume-delete@1", {
  riskTier: "high",
  description: "Permanently delete a volume and its backups",
});
// A scoped deletion skill is the dangerous variant modeled as its own skill: it
// carries a path limit confining it to the staging environment, so a production
// volume path is refused at the proxy (fail closed).
const stagingDelete = await ensureSkill(client, "pocketos-staging-volume-delete@1", {
  description: "Delete a volume under the staging environment only",
});

// The staging role does the prepare work: read and snapshot. It holds NO
// deletion grant — deny by default refuses any deletion regardless of token.
const stagingRole = await ensureRole(client, "pocketos-staging-deploy-role", {
  description: "Inspects and snapshots; cannot delete production volumes.",
  limits: {
    skills: {
      "pocketos-infra-read@1": { maxInvocationsPerRun: 20 },
      "pocketos-staging-volume-delete@1": {
        pathScope: { field: "volumePath", prefix: "/env/staging" },
      },
    },
  },
});
// The infra owner is the only role where deletion is a real duty.
const infraOwnerRole = await ensureRole(client, "pocketos-infra-owner-role", {
  description: "Owns irreversible teardown; deletion runs behind an approval gate.",
});

await ensureGrant(client, stagingRole, read);
await ensureGrant(client, stagingRole, snapshot);
await ensureGrant(client, stagingRole, stagingDelete);
await ensureGrant(client, infraOwnerRole, volumeDelete);

await ensureAgent(client, "pocketos-staging-bot", "pocketos-staging-deploy-role");
await ensureAgent(client, "pocketos-infra-owner-bot", "pocketos-infra-owner-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "pocketos-staging-deploy" });
console.log(`proxy session ${session.id} opened\n`);

const inspect = governedTool(client, session.id, "pocketos-staging-bot", "pocketos-infra-read@1", async (i) => ({ services: ["api", "db"], target: i.env }));
const takeSnapshot = governedTool(client, session.id, "pocketos-staging-bot", "pocketos-db-snapshot@1", async (i) => ({ snapshot: i.volume, status: "captured" }));
const stagingWipe = governedTool(client, session.id, "pocketos-staging-bot", "pocketos-infra-volume-delete@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const ownerWipe = governedTool(client, session.id, "pocketos-infra-owner-bot", "pocketos-infra-volume-delete@1", async () => { throw new Error("unreachable: high-risk blocks this on the proxy"); });
const scopedDelete = governedTool(client, session.id, "pocketos-staging-bot", "pocketos-staging-volume-delete@1", async (i) => ({ deleted: i.volumePath, status: "removed" }));

// 1. The agent does its staging work: inspect and snapshot. Both low risk, allowed.
console.log("agent inspects env:", JSON.stringify(await inspect({ env: "staging" })));
console.log("agent snapshots db:", JSON.stringify(await takeSnapshot({ volume: "staging-db" })));

// 2. The agent attempts the PocketOS wipe against the production volume. The
//    staging role was never granted deletion, so deny-by-default refuses it.
//    Holding the root Railway token does not change the decision.
try {
  await stagingWipe({ volumePath: "/env/production/db" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`production wipe DENIED (${err.code}): ${err.reason}`);
}

// 3. Even the infra owner, who DOES hold the deletion grant, is refused on the
//    proxy: a high-risk skill must run inside a governed flow behind an
//    approval gate — the checkpoint the incident lacked.
try {
  await ownerWipe({ volumePath: "/env/production/db" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`owner wipe DENIED (${err.code}): ${err.reason}`);
}

// 4. The scoped staging deletion is allowed only within the staging prefix.
console.log("scoped delete (staging):", JSON.stringify(await scopedDelete({ volumePath: "/env/staging/scratch" })));

// 5. The same scoped skill aimed at a production path is refused: the path limit
//    fails closed, so the dangerous variant can never reach production.
try {
  await scopedDelete({ volumePath: "/env/production/db" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`scoped delete (production) DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
