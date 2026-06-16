// Shared helpers for the runnable incident examples. Each example configures
// MakerChecker for its scenario (roles, skills, grants, limits), then drives a
// governed agent through the proxy and prints the audit trail. These helpers are
// idempotent so an example can be re-run against a persistent server.
//
// Run an example against a server booted with MAKERCHECKER_AUTH_DISABLED=1, or
// set MAKERCHECKER_API_KEY to an admin key. See examples/README.md.
import {
  createClient,
  governedTool,
  GovernanceDeniedError,
} from "../../packages/sdk/dist/index.js";

export { governedTool, GovernanceDeniedError };

export function connect() {
  return createClient({
    baseUrl: process.env.MAKERCHECKER_URL ?? "http://localhost:3000",
    ...(process.env.MAKERCHECKER_API_KEY ? { apiKey: process.env.MAKERCHECKER_API_KEY } : {}),
  });
}

/** Publish a skill at name@version, or return the existing one. */
export async function ensureSkill(client, ref, { riskTier = "low", description = "" } = {}) {
  const [name, versionStr] = ref.split("@");
  const version = Number(versionStr);
  const { skills } = await client.skills.list();
  const found = skills.find((s) => s.name === name && s.version === version);
  if (found) return found;
  const { skill } = await client.skills.publish({
    name,
    version,
    description: description || `${name} (incident-example skill)`,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    implementation: { type: "local" },
    riskTier,
  });
  return skill;
}

/** Create a role with optional limits, or return the existing one. */
export async function ensureRole(client, name, { description = "", limits } = {}) {
  const { roles } = await client.roles.list();
  const found = roles.find((r) => r.name === name);
  if (found) return found;
  const { role } = await client.roles.create({
    name,
    ...(description ? { description } : {}),
    ...(limits ? { limits } : {}),
  });
  return role;
}

/** Create an agent bound to a role by name, or return the existing one. */
export async function ensureAgent(client, name, roleName) {
  const { agents } = await client.agents.list();
  const found = agents.find((a) => a.name === name);
  if (found) return found;
  const { agent } = await client.agents.create({ name, roleName });
  return agent;
}

/** Grant a skill to a role; a no-op if the grant already exists. */
export async function ensureGrant(client, role, skill) {
  try {
    await client.grants.create({ roleId: role.id, skillId: skill.id });
  } catch {
    // Already granted (unique constraint) — deny-by-default is unchanged.
  }
}

/** Print a session's audit trail and verify the chain. Returns the verdict. */
export async function printTrailAndVerify(client, sessionId) {
  const { auditEvents } = await client.proxy.getSession(sessionId);
  console.log("\naudit trail:");
  for (const e of auditEvents) {
    const p = e.payload ?? {};
    const ref = p.skillRef ? ` ${p.agentName ?? ""} -> ${p.skillRef}` : "";
    const code = p.code ? ` [${p.code}]` : "";
    console.log(`  ${e.seq}  ${e.event_type}${ref}${code}`);
  }
  const verdict = await client.audit.verify();
  console.log(`\naudit chain: ok=${verdict.ok} events=${verdict.count}`);
  return verdict;
}
