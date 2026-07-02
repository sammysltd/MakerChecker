/**
 * Asserts that every gauntlet payload is blocked with the expected refusal,
 * that runaway loops are cut off at their invocation cap, that fail-closed
 * amount semantics match the engine (missing / non-numeric / negative amount
 * on a limited skill => denial), that payload-asserted gate passage is
 * ignored, and that the positive controls — in-policy calls, at least two per
 * role — ARE allowed, so the harness is demonstrably not rigged to block
 * everything.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { enforce } from "../src/enforce.js";
import { runSession } from "../src/harness.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(join(ROOT, "policies", "example-policy.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(ROOT, "corpus.json"), "utf8"));

let failures = 0;
const check = (cond, msg) => { if (cond) console.log(`  ok  ${msg}`); else { console.error(`  FAIL ${msg}`); failures++; } };

// --- attack payloads: every malicious objective must be blocked ---
let objectivesExecuted = 0;
for (const p of corpus.payloads) {
  const s = runSession(policy, p);
  if (s.completed) objectivesExecuted++;
  check(!s.completed, `${p.id} objective blocked`);
  check(s.decision.refusal === p.expectedRefusal, `${p.id} refusal "${s.decision.refusal}" matches expected "${p.expectedRefusal}"`);
  if ((p.repeat ?? 1) > 1) {
    check(s.executedCalls < s.attempts, `${p.id} runaway loop cut off at the cap (${s.executedCalls}/${s.attempts} calls executed)`);
  }
}
check(objectivesExecuted === 0, `zero malicious objectives executed (${objectivesExecuted}/${corpus.payloads.length})`);

// --- fail-closed limit semantics (mirrors packages/server/src/engine/limits.ts) ---
const omitted = enforce(policy, { role: "exec-agent", skill: "order.submit" });
check(!omitted.allowed && omitted.refusal === "limit_violation", "omitted amount on a limited skill fails closed (limit_violation)");
const nonNumeric = enforce(policy, { role: "exec-agent", skill: "order.submit", amount: "500000" });
check(!nonNumeric.allowed && nonNumeric.refusal === "limit_violation", "non-numeric amount on a limited skill fails closed");
const nan = enforce(policy, { role: "exec-agent", skill: "order.submit", amount: NaN });
check(!nan.allowed && nan.refusal === "limit_violation", "NaN amount on a limited skill fails closed");
const negative = enforce(policy, { role: "exec-agent", skill: "order.submit", amount: -500000 });
check(!negative.allowed && negative.refusal === "limit_violation", "negative amount fails closed (must not slip under the ceiling)");

// --- the payload cannot assert its own gate passage ---
const spoofed = enforce(policy, { role: "wallet-assistant", skill: "wallet.transfer", amount: 10, throughGate: true });
check(!spoofed.allowed && spoofed.refusal === "high_risk_requires_gate", "payload-asserted throughGate is ignored (gate still required)");
const approved = enforce(policy, { role: "wallet-assistant", skill: "wallet.transfer", amount: 10 }, { approvals: ["wallet.transfer"] });
check(approved.allowed, "harness-recorded approval satisfies the gate");

// --- invocation counting is harness state, not payload data ---
const capped = enforce(policy, { role: "scan-agent", skill: "cloud.provision", amount: 1 }, { priorInvocations: 1 });
check(!capped.allowed && capped.refusal === "limit_violation", "invocation cap enforced from the harness counter");
const first = enforce(policy, { role: "scan-agent", skill: "cloud.provision", amount: 1 }, { priorInvocations: 0 });
check(first.allowed, "first in-cap invocation is allowed");

// --- positive controls: in-policy calls must be ALLOWED (>= 2 per role) ---
let controlsBlocked = 0;
for (const c of corpus.controls) {
  const s = runSession(policy, c);
  if (!s.completed) controlsBlocked++;
  check(s.completed, `${c.id} positive control allowed: ${c.role} · ${c.call.skill}`);
}
check(controlsBlocked === 0, `all ${corpus.controls.length} positive controls allowed`);
const perRole = {};
for (const c of corpus.controls) perRole[c.role] = (perRole[c.role] ?? 0) + 1;
for (const role of Object.keys(policy.roles)) {
  check((perRole[role] ?? 0) >= 2, `role "${role}" has at least 2 positive controls (${perRole[role] ?? 0})`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
