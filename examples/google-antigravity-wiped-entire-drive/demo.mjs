#!/usr/bin/env node
// Google Antigravity (Dec 2025): asked to clear a cache folder, the agentic IDE
// ran a silent recursive `rmdir` against the root of the D drive and deleted the
// whole partition, with no confirmation between path resolution and destruction.
//
// The controls that stop it: the coding role holds only reversible, project-scoped
// file skills (deny-by-default refuses any recursive delete it was never granted);
// the recursive-delete skill is published high-risk, so the proxy categorically
// refuses it outside a governed flow with a preceding approval gate; and where a
// scoped cleanup is a real duty, the delete skill carries a path scope pinned to
// the project root, so a drive-root target is rejected fail-closed.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/google-antigravity-wiped-entire-drive/demo.mjs
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

const PROJECT_ROOT = "/srv/project";

// --- Configure MakerChecker for the scenario -------------------------------
const read = await ensureSkill(client, "gant-fs-read@1", { description: "Read files and list directories under the project root" });
const write = await ensureSkill(client, "gant-fs-write@1", { description: "Write files under the project root" });
const rmdirRecursive = await ensureSkill(client, "gant-fs-rmdir-recursive@1", {
  riskTier: "high",
  description: "Recursively delete a directory tree (irreversible)",
});
const cleanCache = await ensureSkill(client, "gant-fs-clean-cache@1", {
  description: "Delete a cache directory confined to the project root",
});

// coding-agent reads and writes within the project; it holds NO recursive-delete
// grant (deny by default) and no skill that can target a path outside the root.
const codingRole = await ensureRole(client, "gant-coding-agent-role", {
  description: "Reads and writes within the project; cannot recursively delete.",
  limits: {
    skills: {
      "gant-fs-read@1": { maxInvocationsPerRun: 50 },
      "gant-fs-clean-cache@1": { pathScope: { field: "path", prefix: PROJECT_ROOT } },
    },
  },
});

await ensureGrant(client, codingRole, read);
await ensureGrant(client, codingRole, write);
await ensureGrant(client, codingRole, cleanCache);
// gant-fs-rmdir-recursive@1 is intentionally NOT granted to the coding role.

await ensureAgent(client, "gant-coding-bot", "gant-coding-agent-role");

// --- Drive the governed agent through the proxy ----------------------------
const { session } = await client.proxy.openSession({ label: "google-antigravity-drive-wipe" });
console.log(`proxy session ${session.id} opened\n`);

const readFile = governedTool(client, session.id, "gant-coding-bot", "gant-fs-read@1", async (i) => ({ read: i.path }));
const writeFile = governedTool(client, session.id, "gant-coding-bot", "gant-fs-write@1", async (i) => ({ wrote: i.path }));
const wipeRecursive = governedTool(client, session.id, "gant-coding-bot", "gant-fs-rmdir-recursive@1", async () => { throw new Error("unreachable: high-risk skill is refused at the proxy"); });
const cleanCacheDir = governedTool(client, session.id, "gant-coding-bot", "gant-fs-clean-cache@1", async (i) => ({ cleaned: i.path }));

// 1. The agent reads and stages cache files within the project — allowed.
console.log("agent reads cache listing:", JSON.stringify(await readFile({ path: `${PROJECT_ROOT}/.cache/index` })));
console.log("agent stages a manifest:", JSON.stringify(await writeFile({ path: `${PROJECT_ROOT}/.cache/manifest.txt` })));

// 2. "Clear the cache" resolves to a recursive delete of the D drive root. The
//    coding role was never granted the recursive-delete skill, so deny-by-default
//    refuses it before any filesystem operation runs — the mis-resolved path is
//    irrelevant because the capability was never grantable to this role.
try {
  await wipeRecursive({ path: "D:\\" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`recursive wipe of D:\\ DENIED (${err.code}): ${err.reason}`);
}

// 3. Even if that skill were somehow reachable, it is published high-risk, so the
//    proxy categorically refuses it outside a governed flow with an approval gate.
//    Grant it to the coding role and attempt it directly to show the proxy refusal.
await ensureGrant(client, codingRole, rmdirRecursive);
try {
  await wipeRecursive({ path: `${PROJECT_ROOT}/build` });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`high-risk recursive delete DENIED (${err.code}): ${err.reason}`);
}

// 4. The scoped cleanup that IS a real duty: a delete confined to the project
//    root. A cache subtree inside the project is allowed; the drive root is
//    rejected fail-closed by the path scope.
console.log("scoped cache clean inside project:", JSON.stringify(await cleanCacheDir({ path: `${PROJECT_ROOT}/.cache` })));
try {
  await cleanCacheDir({ path: "D:\\" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`scoped clean of D:\\ DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
