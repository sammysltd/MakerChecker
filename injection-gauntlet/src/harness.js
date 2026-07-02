/**
 * Session runner shared by src/run.mjs and scripts/test.mjs.
 *
 * The harness — not the payload — owns all session state: which gate
 * approvals exist and how many calls have already executed. This mirrors
 * production, where the server derives gate status from flow structure
 * (packages/server/src/engine/enforcement.ts:46-57) and counts prior
 * invocations from the audit log (packages/server/src/engine/limits.ts),
 * never from anything the agent asserts about itself.
 */

import { enforce } from "./enforce.js";

/**
 * Strip any gate/approval/counter assertions arriving from the
 * (attacker-controlled) payload. A subverted agent claiming
 * `"throughGate": true` must not be able to unlock a high-risk skill, and it
 * must not be able to reset its own invocation count.
 */
export function sanitizeCall(attemptedCall) {
  const { throughGate, gate, approvals, priorInvocations, ...call } = attemptedCall ?? {};
  return call;
}

/**
 * Run one corpus entry as a session: `repeat` identical calls (default 1),
 * counting executed invocations in harness state and stopping at the first
 * refusal (enforcement cut the session off; the remaining calls never run).
 * Gate approvals come only from the entry's harness-level `approvals` field —
 * the payload (`attemptedCall`) cannot write them.
 *
 * @returns { attempts, executedCalls, completed, decision }
 *   `completed` is true only when every attempted call executed, i.e. the
 *   session's objective ran to completion.
 */
export function runSession(policy, entry) {
  const attempts = entry.repeat ?? 1;
  const call = sanitizeCall(entry.attemptedCall ?? entry.call);
  const approvals = entry.approvals ?? [];
  let executedCalls = 0;
  let decision = { allowed: false, refusal: null, reason: "no calls attempted" };
  for (let i = 0; i < attempts; i++) {
    decision = enforce(policy, { role: entry.role, ...call }, { approvals, priorInvocations: executedCalls });
    if (!decision.allowed) break;
    executedCalls++;
  }
  return { attempts, executedCalls, completed: executedCalls === attempts, decision };
}
