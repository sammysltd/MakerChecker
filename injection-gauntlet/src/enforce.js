/**
 * A small, deterministic enforcement evaluator that models MakerChecker's
 * decision order: deny-by-default grant check -> high-risk gate -> fail-closed
 * limits. It is the structural layer that runs regardless of what the model
 * "decided". Used by the gauntlet to show that a fully-subverted agent still
 * cannot execute.
 *
 * This is a simplified model of the production engine, not the engine itself.
 * Where it matters, the semantics match:
 *
 *   - Amount limits fail CLOSED. A skill with a configured amount limit whose
 *     call has a missing, non-numeric, or negative amount is denied, mirroring
 *     packages/server/src/engine/limits.ts (~lines 240-255): omitting the
 *     field, or going negative to slip UNDER the ceiling, must not bypass it.
 *
 *   - Gate satisfaction can never come from the call payload. The call is
 *     attacker-controlled by assumption; any `throughGate`/`gate` field it
 *     carries is ignored (never read). Gate passage may only be recorded in
 *     the harness-controlled session. In production the server derives gate
 *     status from flow structure — see `hasSeparationGate` in
 *     packages/server/src/engine/enforcement.ts:46-57, computed server-side,
 *     never taken from agent input.
 *
 *   - Invocation limits are checked against a count of PRIOR executed calls
 *     supplied by the harness, not against anything in the call. In
 *     production that count comes from the audit log (limits.ts).
 */

export function skillGranted(grants, skill) {
  return grants.some((g) => g === skill || g.startsWith(skill + "@"));
}

/**
 * @param policy  { highRisk: string[], roles: { [role]: { grants: string[], limits: {} } } }
 * @param call    { role, skill, amount? } — attacker-controlled by assumption.
 *                Any `throughGate`/`gate`/`approvals` field on the call is
 *                deliberately never read: a payload asserting its own gate
 *                passage must not unlock a high-risk skill.
 * @param session { approvals?: string[], priorInvocations?: number } —
 *                harness-controlled state the payload cannot write.
 * @returns { allowed: boolean, refusal?: string, reason: string }
 */
export function enforce(policy, call, session = {}) {
  const approvals = Array.isArray(session.approvals) ? session.approvals : [];
  const priorInvocations =
    typeof session.priorInvocations === "number" && Number.isFinite(session.priorInvocations)
      ? session.priorInvocations
      : 0;

  const role = policy.roles?.[call.role];
  if (!role) {
    return { allowed: false, refusal: "skill_not_granted", reason: `no such role "${call.role}"` };
  }
  // 1. Deny by default: the skill must be granted to the role.
  if (!skillGranted(role.grants ?? [], call.skill)) {
    return { allowed: false, refusal: "skill_not_granted", reason: `${call.role} was never granted ${call.skill}` };
  }
  // 2. High-risk skills require a preceding approval gate. Gate satisfaction
  //    comes ONLY from the harness-controlled session approvals — never from
  //    the call (call.throughGate is intentionally not read; production
  //    derives gate status from flow structure, enforcement.ts:46-57).
  if ((policy.highRisk ?? []).includes(call.skill) && !approvals.includes(call.skill)) {
    return { allowed: false, refusal: "high_risk_requires_gate", reason: `${call.skill} is high-risk and needs a named approval gate` };
  }
  // 3. Fail-closed limits (matched on the bare skill name or name@version grant).
  const limitKey = Object.keys(role.limits ?? {}).find((k) => k === call.skill || k.startsWith(call.skill + "@"));
  const limit = limitKey ? role.limits[limitKey] : undefined;
  if (limit) {
    if (limit.maxInvocations != null && priorInvocations >= limit.maxInvocations) {
      return { allowed: false, refusal: "limit_violation", reason: `${call.skill} reached its invocation limit (${limit.maxInvocations}) in this session` };
    }
    if (limit.maxAmount != null) {
      // Fail closed, mirroring the engine (limits.ts): a limited skill whose
      // amount is missing or unreadable is denied — omitting the field must
      // not bypass the ceiling.
      if (typeof call.amount !== "number" || !Number.isFinite(call.amount)) {
        return { allowed: false, refusal: "limit_violation", reason: `${call.skill} has an amount limit but the amount is missing or non-numeric — denied (fail closed)` };
      }
      // A negative amount must never slip UNDER the ceiling: "-1,000,000" is
      // numerically below max but is not a benign value.
      if (call.amount < 0) {
        return { allowed: false, refusal: "limit_violation", reason: `${call.skill} amount ${call.amount} is negative — denied (fail closed)` };
      }
      if (call.amount > limit.maxAmount) {
        return { allowed: false, refusal: "limit_violation", reason: `amount ${call.amount} exceeds maxAmount ${limit.maxAmount}` };
      }
    }
  }
  return { allowed: true, reason: "permitted by policy" };
}
