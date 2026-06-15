import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * The v0 flow-definition grammar. Frozen for v0 (see plan, risk #3):
 * sequential steps only — no branching, no parallelism, no expressions.
 */

/**
 * Canonical skill-reference pattern: name@version with a POSITIVE integer
 * version and no leading zero. Anchored so "pay@01", "pay@1@x", "pay@1 ", and
 * "Pay@1" are rejected. This matters beyond cosmetics: skills are resolved by
 * (name, version) but per-skill limits and invocation counts are keyed by the
 * ref string, so a non-canonical ref that resolves to the same skill would miss
 * the limit-map key and skip the ceiling. One canonical spelling keeps the two
 * key-spaces aligned.
 */
export const SKILL_REF_PATTERN = "^[a-z0-9][a-z0-9-]*@[1-9][0-9]*$";

export const SkillRef = Type.String({
  pattern: SKILL_REF_PATTERN,
  description: "skill reference as name@version, e.g. csv-ingest@1",
});

export const AgentStep = Type.Object(
  {
    key: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$", maxLength: 200 }),
    agent: Type.String({ minLength: 1 }),
    // Bound skills per step: each ref is one ungranted-skill check at run time,
    // so an oversized list amplifies into serial DB work (see steps maxItems).
    skills: Type.Array(SkillRef, { minItems: 1, maxItems: 50 }),
    instructions: Type.Optional(Type.String({ maxLength: 4000 })),
    retries: Type.Optional(
      Type.Object(
        {
          max_attempts: Type.Integer({ minimum: 1, maximum: 10 }),
          backoff: Type.Optional(
            Type.Union([Type.Literal("none"), Type.Literal("exponential")]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3_600_000 })),
  },
  { additionalProperties: false },
);

/** Pragmatic email shape check; real identity is settled against users.email. */
const EMAIL_PATTERN = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

export const ApprovalGateApprovals = Type.Object(
  {
    min_approvals: Type.Optional(Type.Integer({ minimum: 1 })),
    approver_emails: Type.Optional(
      Type.Array(Type.String({ pattern: EMAIL_PATTERN }), { minItems: 1, maxItems: 100 }),
    ),
    forbid_requester: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ApprovalGateStep = Type.Object(
  {
    key: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$", maxLength: 200 }),
    type: Type.Literal("approval_gate"),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    // Optional n-of-m named approvals. Defining this object switches the gate
    // into identity mode: forbid_requester defaults to TRUE, and decisions
    // must come from authenticated users (fail closed).
    approvals: Type.Optional(ApprovalGateApprovals),
  },
  { additionalProperties: false },
);

export const FlowDefinitionSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: 200 }),
    // Bound the step count: each step is published, scheduled, and audited
    // serially, so an oversized definition would amplify into tens of thousands
    // of serial DB queries from a single POST /flows. 200 is well above any real
    // sequential flow while still capping the blast radius.
    steps: Type.Array(Type.Union([ApprovalGateStep, AgentStep]), {
      minItems: 1,
      maxItems: 200,
    }),
  },
  { additionalProperties: false },
);

export type FlowDefinition = Static<typeof FlowDefinitionSchema>;
export type FlowStep = FlowDefinition["steps"][number];
export type AgentStepDef = Static<typeof AgentStep>;
export type ApprovalGateStepDef = Static<typeof ApprovalGateStep>;
export type ApprovalGateApprovalsDef = Static<typeof ApprovalGateApprovals>;

export function isApprovalGate(step: FlowStep): step is ApprovalGateStepDef {
  return "type" in step && step.type === "approval_gate";
}

export type FlowValidationResult =
  | { ok: true; definition: FlowDefinition }
  | { ok: false; errors: string[] };

/** Structural + semantic validation; run at publish time, never at run time. */
export function validateFlowDefinition(value: unknown): FlowValidationResult {
  if (!Value.Check(FlowDefinitionSchema, value)) {
    const errors = [...Value.Errors(FlowDefinitionSchema, value)].map(
      (e) => `${e.path || "/"}: ${e.message}`,
    );
    return { ok: false, errors };
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const step of value.steps) {
    if (seen.has(step.key)) errors.push(`duplicate step key "${step.key}"`);
    seen.add(step.key);
  }
  const agentSteps = value.steps.filter((s) => !isApprovalGate(s));
  if (agentSteps.length === 0) {
    errors.push("flow must contain at least one agent step");
  }
  const consecutiveGates = value.steps.some((s, i) => {
    const next = value.steps[i + 1];
    return next !== undefined && isApprovalGate(s) && isApprovalGate(next);
  });
  if (consecutiveGates) {
    errors.push("consecutive approval gates are not allowed");
  }
  for (const step of value.steps) {
    if (!isApprovalGate(step) || !step.approvals) continue;
    const { min_approvals, approver_emails } = step.approvals;
    if (
      min_approvals !== undefined &&
      approver_emails !== undefined &&
      min_approvals > approver_emails.length
    ) {
      errors.push(
        `step "${step.key}": min_approvals (${min_approvals}) exceeds the number of ` +
          `approver_emails (${approver_emails.length}) — the gate could never resolve`,
      );
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, definition: value };
}
