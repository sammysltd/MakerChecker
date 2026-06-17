import {
  gateEnforcesSeparation,
  isApprovalGate,
  validateFlowDefinition,
  type FlowDefinition,
} from "@makerchecker/shared";
import type { Pool, PoolClient } from "pg";

import { recordEvent, type Actor } from "../audit/writer.js";
import { strictSod } from "../config.js";
import { parseSkillRef } from "./enforcement.js";

export class FlowValidationError extends Error {
  override name = "FlowValidationError";
  constructor(readonly errors: string[]) {
    super(`invalid flow definition:\n${errors.join("\n")}`);
  }
}

export interface PublishedFlowVersion {
  flowId: string;
  flowVersionId: string;
  version: number;
  definition: FlowDefinition;
}

/**
 * Validates and publishes a new flow version (creating the flow if needed).
 * Published versions are immutable — every change is a new version.
 */
export async function publishFlowVersion(
  pool: Pool,
  input: { definition: unknown; actor: Actor; createdByUserId?: string },
): Promise<PublishedFlowVersion> {
  const validation = validateFlowDefinition(input.definition);
  if (!validation.ok) throw new FlowValidationError(validation.errors);
  const definition = validation.definition;
  await validateRiskTiers(pool, definition);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const flow = await client.query<{ id: string }>(
      `INSERT INTO flows (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [definition.name],
    );
    const flowId = flow.rows[0]!.id;

    const next = await client.query<{ v: number }>(
      "SELECT coalesce(max(version), 0) + 1 AS v FROM flow_versions WHERE flow_id = $1",
      [flowId],
    );
    const version = next.rows[0]!.v;

    const fv = await client.query<{ id: string }>(
      `INSERT INTO flow_versions (flow_id, version, definition, status, created_by_user_id)
       VALUES ($1, $2, $3, 'published', $4) RETURNING id`,
      [flowId, version, JSON.stringify(definition), input.createdByUserId ?? null],
    );
    const flowVersionId = fv.rows[0]!.id;

    await recordEvent(client, {
      eventType: "flow.published",
      actor: input.actor,
      entityType: "flow_version",
      entityId: flowVersionId,
      payload: { flowName: definition.name, version, definition },
    });

    await client.query("COMMIT");
    return { flowId, flowVersionId, version, definition };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Publish-time risk check: a high-risk skill may only appear in a step that has
 * a SEPARATION-ENFORCING approval gate somewhere before it — an identity-mode
 * gate (`approvals` object) that does not disable `forbid_requester`. A legacy
 * gate proves a human paused, but lets the run's own requester self-approve, so
 * it cannot guard an irreversible high-risk action (see gateEnforcesSeparation).
 * Skills not yet in the registry are tolerated here (runtime enforcement still
 * denies them by default).
 *
 * In strict mode (MAKERCHECKER_REQUIRE_IDENTITY_GATES=1) every approval gate must
 * be separation-enforcing — no self-approvable gate may be published at all.
 */
async function validateRiskTiers(pool: Pool, definition: FlowDefinition): Promise<void> {
  const errors: string[] = [];
  const strict = strictSod();
  let separationGateSeen = false;
  for (const step of definition.steps) {
    if (isApprovalGate(step)) {
      if (gateEnforcesSeparation(step)) separationGateSeen = true;
      else if (strict) {
        errors.push(
          `step "${step.key}": strict mode (MAKERCHECKER_REQUIRE_IDENTITY_GATES) requires every ` +
            "approval gate to enforce approver separation (an `approvals` object with " +
            "forbid_requester not disabled), so no gate is self-approvable",
        );
      }
      continue;
    }
    if (separationGateSeen) continue;
    for (const ref of step.skills) {
      const { name, version } = parseSkillRef(ref);
      const { rows } = await pool.query<{ risk_tier: string }>(
        "SELECT risk_tier FROM skills WHERE name = $1 AND version = $2",
        [name, version],
      );
      if (rows[0]?.risk_tier === "high") {
        errors.push(
          `step "${step.key}": skill "${ref}" is high-risk and requires a preceding approval ` +
            "gate that enforces approver separation (an `approvals` object with forbid_requester " +
            "not disabled), so the run's requester cannot approve their own work",
        );
      }
    }
  }
  if (errors.length) throw new FlowValidationError(errors);
}

export async function loadDefinition(
  client: PoolClient,
  flowVersionId: string,
): Promise<FlowDefinition> {
  const { rows } = await client.query<{ definition: FlowDefinition }>(
    "SELECT definition FROM flow_versions WHERE id = $1",
    [flowVersionId],
  );
  if (!rows[0]) throw new Error(`flow version ${flowVersionId} not found`);
  return rows[0].definition;
}
