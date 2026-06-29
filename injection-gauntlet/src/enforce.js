/**
 * A small, deterministic enforcement evaluator that mirrors MakerChecker's
 * decision order: deny-by-default grant check -> high-risk gate -> fail-closed
 * limits. It is the structural layer that runs regardless of what the model
 * "decided". Used by the gauntlet to show that a fully-subverted agent still
 * cannot execute.
 */

export function skillGranted(grants, skill) {
  return grants.some((g) => g === skill || g.startsWith(skill + "@"));
}

/**
 * @param policy { highRisk: string[], roles: { [role]: { grants: string[], limits: {} } } }
 * @param call   { role, skill, amount?, throughGate?: boolean }
 * @returns { allowed: boolean, refusal?: string, reason: string }
 */
export function enforce(policy, call) {
  const role = policy.roles?.[call.role];
  if (!role) {
    return { allowed: false, refusal: "skill_not_granted", reason: `no such role "${call.role}"` };
  }
  // 1. Deny by default: the skill must be granted to the role.
  if (!skillGranted(role.grants ?? [], call.skill)) {
    return { allowed: false, refusal: "skill_not_granted", reason: `${call.role} was never granted ${call.skill}` };
  }
  // 2. High-risk skills require a preceding approval gate.
  if ((policy.highRisk ?? []).includes(call.skill) && !call.throughGate) {
    return { allowed: false, refusal: "high_risk_requires_gate", reason: `${call.skill} is high-risk and needs a named approval gate` };
  }
  // 3. Fail-closed limits (matched on the bare skill name or name@version grant).
  const limitKey = Object.keys(role.limits ?? {}).find((k) => k === call.skill || k.startsWith(call.skill + "@"));
  const limit = limitKey ? role.limits[limitKey] : undefined;
  if (limit && call.amount != null) {
    if (limit.maxAmount != null && call.amount > limit.maxAmount) {
      return { allowed: false, refusal: "limit_violation", reason: `amount ${call.amount} exceeds maxAmount ${limit.maxAmount}` };
    }
    if (limit.maxInvocations != null && call.amount > limit.maxInvocations) {
      return { allowed: false, refusal: "limit_violation", reason: `count ${call.amount} exceeds maxInvocations ${limit.maxInvocations}` };
    }
  }
  return { allowed: true, reason: "permitted by policy" };
}
