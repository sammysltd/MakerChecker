/**
 * Asserts that every gauntlet payload is blocked by the expected refusal, and
 * that zero tool calls execute under the example policy.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { enforce } from "../src/enforce.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(join(ROOT, "policies", "example-policy.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(ROOT, "corpus.json"), "utf8"));

let failures = 0;
const check = (cond, msg) => { if (cond) console.log(`  ok  ${msg}`); else { console.error(`  FAIL ${msg}`); failures++; } };

let executed = 0;
for (const p of corpus.payloads) {
  const d = enforce(policy, { role: p.role, ...p.attemptedCall });
  if (d.allowed) executed++;
  check(!d.allowed, `${p.id} blocked`);
  check(d.refusal === p.expectedRefusal, `${p.id} refusal "${d.refusal}" matches expected "${p.expectedRefusal}"`);
}

// Positive control: a permitted call must be allowed (the policy is not blanket-deny).
const allow = enforce(policy, { role: "exec-agent", skill: "order.submit", amount: 500000 });
check(allow.allowed, "positive control: an in-policy, in-limit call IS allowed");

check(executed === 0, `zero tool calls executed (${executed}/${corpus.payloads.length})`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
