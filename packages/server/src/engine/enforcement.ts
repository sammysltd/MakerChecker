import type { PoolClient } from "pg";

/**
 * Pre-execution authorization. Called at BOTH decision time (flow.advance)
 * and invocation time (step.execute) — deny by default, twice.
 *
 * Checks, in order:
 *  1. agent exists and is active
 *  2. every skill@version exists and is published
 *  3. every skill is GRANTED to the agent's role (unrevoked grant — deny by default)
 *  4. high-risk skills require a preceding approval gate in the flow
 *  5. segregation of duties: no role that conflicts with the agent's role may
 *     already have acted in this run (checked against frozen role snapshots)
 */

export class EnforcementError extends Error {
  override name = "EnforcementError";
  constructor(
    readonly code:
      | "agent_not_found"
      | "agent_not_active"
      | "skill_not_found"
      | "skill_deprecated"
      | "skill_not_granted"
      | "high_risk_requires_gate"
      | "sod_violation",
    message: string,
  ) {
    super(message);
  }
}

export interface EnforcedAgent {
  agentId: string;
  agentName: string;
  roleId: string;
  skillIds: Record<string, string>; // "name@version" -> skill id
}

export interface EnforceInput {
  agentName: string;
  skillRefs: string[];
  /** Run context for SoD evaluation. */
  runId: string;
  /** Whether an approval gate precedes this step in the flow definition. */
  hasPrecedingGate: boolean;
}

export function parseSkillRef(ref: string): { name: string; version: number } {
  const [name, version] = ref.split("@");
  return { name: name!, version: Number(version) };
}

/**
 * Where the SoD actor set comes from: a flow run's completed step_runs, or a
 * proxy session's allowed proxy_actions. Both record frozen role snapshots,
 * so reassigning an agent's role later cannot rewrite who acted as what.
 */
export type SodContext = { runId: string } | { proxySessionId: string };

export interface SodConflict {
  priorRoleId: string;
  description: string;
}

/**
 * The single SoD evaluation shared by flow enforcement and the proxy: does
 * any role that already acted in this context form an active constraint pair
 * with the candidate role? Denied proxy checks never enter the actor set —
 * an attempt that was blocked did not act.
 */
export async function checkSodConflict(
  client: PoolClient,
  candidateRoleId: string,
  context: SodContext,
): Promise<SodConflict | null> {
  const actedRoles =
    "proxySessionId" in context
      ? `SELECT DISTINCT pa.role_id_snapshot AS role_id
           FROM proxy_actions pa
          WHERE pa.session_id = $1 AND pa.decision = 'allowed'`
      : `SELECT DISTINCT sr.role_id_snapshot AS role_id
           FROM step_runs sr
          WHERE sr.run_id = $1 AND sr.status = 'completed'`;
  const { rows } = await client.query<{ description: string; prior_role: string }>(
    `SELECT sc.description, acted.role_id::text AS prior_role
       FROM (${actedRoles}) acted
       JOIN sod_constraints sc
         ON sc.revoked_at IS NULL
        AND ((sc.role_a_id = acted.role_id AND sc.role_b_id = $2)
          OR (sc.role_a_id = $2 AND sc.role_b_id = acted.role_id))
      LIMIT 1`,
    ["proxySessionId" in context ? context.proxySessionId : context.runId, candidateRoleId],
  );
  const hit = rows[0];
  return hit ? { priorRoleId: hit.prior_role, description: hit.description } : null;
}

export async function enforce(client: PoolClient, input: EnforceInput): Promise<EnforcedAgent> {
  const agents = await client.query<{ id: string; role_id: string; status: string }>(
    "SELECT id, role_id, status FROM agents WHERE name = $1",
    [input.agentName],
  );
  const agent = agents.rows[0];
  if (!agent) {
    throw new EnforcementError("agent_not_found", `agent "${input.agentName}" does not exist`);
  }
  if (agent.status !== "active") {
    throw new EnforcementError(
      "agent_not_active",
      `agent "${input.agentName}" is ${agent.status}`,
    );
  }

  const skillIds: Record<string, string> = {};
  for (const ref of input.skillRefs) {
    const { name, version } = parseSkillRef(ref);
    const skills = await client.query<{ id: string; status: string; risk_tier: string }>(
      "SELECT id, status, risk_tier FROM skills WHERE name = $1 AND version = $2",
      [name, version],
    );
    const skill = skills.rows[0];
    if (!skill) {
      throw new EnforcementError("skill_not_found", `skill "${ref}" does not exist`);
    }
    if (skill.status !== "published") {
      throw new EnforcementError("skill_deprecated", `skill "${ref}" is ${skill.status}`);
    }

    // Deny by default: an exact, unrevoked grant of this skill version to the
    // agent's role is required. No grant, no execution — there is no bypass.
    const grant = await client.query(
      `SELECT 1 FROM role_skill_grants
        WHERE role_id = $1 AND skill_id = $2 AND revoked_at IS NULL LIMIT 1`,
      [agent.role_id, skill.id],
    );
    if (grant.rows.length === 0) {
      throw new EnforcementError(
        "skill_not_granted",
        `skill "${ref}" is not granted to the role of agent "${input.agentName}"`,
      );
    }

    if (skill.risk_tier === "high" && !input.hasPrecedingGate) {
      throw new EnforcementError(
        "high_risk_requires_gate",
        `skill "${ref}" is high-risk and requires a preceding approval gate`,
      );
    }

    skillIds[ref] = skill.id;
  }

  // Segregation of duties: if any role that already completed a step in this
  // run forms an active constraint pair with this agent's role, block.
  const sod = await checkSodConflict(client, agent.role_id, { runId: input.runId });
  if (sod) {
    throw new EnforcementError(
      "sod_violation",
      `segregation of duties: the role of agent "${input.agentName}" conflicts with ` +
        `role ${sod.priorRoleId} which already acted in this run` +
        (sod.description ? ` (${sod.description})` : ""),
    );
  }

  return {
    agentId: agent.id,
    agentName: input.agentName,
    roleId: agent.role_id,
    skillIds,
  };
}
