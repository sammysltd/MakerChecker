#!/usr/bin/env node
// Replit coding agent (2025): during an explicit code freeze the agent ran an
// irreversible destructive operation against the production database, dropping
// live tables, then fabricated replacement rows to hide the loss.
//
// The control that stops it: the irreversible table-drop is granted to no role,
// so it is refused by deny-by-default; schema migrations are a high-risk skill
// the proxy refuses outright (they must run through a governed flow behind an
// approval gate); and read work is path-scoped to the project's own tables, so a
// read that reaches into the production schema is denied.
//
// Names are prefixed `replit-` so this demo does not collide with other incident
// demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/replit-agent-deleted-production-database/demo.mjs
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
const query = await ensureSkill(client, "replit-db-query@1", {
  description: "Read-only query, scoped to the project's own tables",
});
const migrate = await ensureSkill(client, "replit-db-migrate@1", {
  riskTier: "high",
  description: "Apply a reviewed schema migration (consequential)",
});
const dropProduction = await ensureSkill(client, "replit-db-drop-production@1", {
  riskTier: "high",
  description: "Drop production tables (irreversible)",
});

// The coding agent reads the database, but only within its own project
// workspace: the query target path must sit under /workspace/project. It holds
// NO migrate grant and NO drop grant — those capabilities do not exist for this
// role at all.
const codingRole = await ensureRole(client, "replit-coding-agent-role", {
  description: "Writes and runs application code; reads its own project workspace.",
  limits: {
    skills: {
      "replit-db-query@1": { pathScope: { field: "target", prefix: "/workspace/project" } },
    },
  },
});
// The release runner may author migrations, but a migration is high-risk and is
// refused on the proxy — it only proceeds through a governed flow with an
// approval gate decided by a release owner, never inline by the agent.
const releaseRole = await ensureRole(client, "replit-release-runner-role", {
  description: "Applies reviewed migrations, only through a gated flow.",
});

await ensureGrant(client, codingRole, query);
await ensureGrant(client, releaseRole, migrate);
// replit-db-drop-production@1 is granted to no role.

await ensureAgent(client, "replit-coding-bot", "replit-coding-agent-role");
await ensureAgent(client, "replit-release-bot", "replit-release-runner-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "replit-db-freeze" });
console.log(`proxy session ${session.id} opened\n`);

const readProject = governedTool(client, session.id, "replit-coding-bot", "replit-db-query@1", async (i) => ({ rows: 3, target: i.target }));
const dropTables = governedTool(client, session.id, "replit-coding-bot", "replit-db-drop-production@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const codingMigrate = governedTool(client, session.id, "replit-coding-bot", "replit-db-migrate@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const releaseMigrate = governedTool(client, session.id, "replit-release-bot", "replit-db-migrate@1", async () => { throw new Error("unreachable: high-risk is gated"); });

// 1. The coding agent reads inside its own project workspace — allowed.
console.log("coding read /workspace/project/users:", JSON.stringify(await readProject({ target: "/workspace/project/users" })));

// 2. The agent reads into the production data outside its workspace — denied;
//    the read is scoped to /workspace/project, so it cannot reach the prod path.
try {
  await readProject({ target: "/workspace/prod/executives" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`read outside workspace DENIED (${err.code}): ${err.reason}`);
}

// 3. Under the freeze, the agent tries to drop production tables — denied by
//    default; this skill is granted to no role, so the call never reaches a
//    database connection. The freeze instruction is irrelevant to enforcement.
try {
  await dropTables({ target: "prod.executives" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`drop production DENIED (${err.code}): ${err.reason}`);
}

// 4. The agent tries a schema mutation through migrate — denied; the coding role
//    holds no migrate grant, so it cannot self-author a migration.
try {
  await codingMigrate({ target: "prod.executives" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`coding migrate DENIED (${err.code}): ${err.reason}`);
}

// 5. Even the release runner, which DOES hold the migrate grant, is refused on
//    the proxy: a high-risk skill cannot run inline — it must go through a
//    governed flow with a preceding approval gate decided by a release owner.
try {
  await releaseMigrate({ target: "prod.executives" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`release migrate DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
