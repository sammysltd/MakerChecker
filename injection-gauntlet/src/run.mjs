#!/usr/bin/env node
/**
 * InjectionGauntlet harness.
 *
 * Premise: assume the WORST case at the model layer — every prompt injection
 * fully subverts the agent's intent. The only question is whether the agent can
 * then EXECUTE the malicious tool call. The gauntlet runs each payload against a
 * governance policy and scores "agent subverted" (always yes, by assumption)
 * against "tool executed" (decided by structural enforcement).
 *
 * Usage:
 *   node src/run.mjs [--policy <policy.json>] [--corpus <corpus.json>] [--json]
 *
 * Exit: 0 if zero tool calls executed (enforcement held), 1 otherwise.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { enforce } from "./enforce.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}
const asJson = process.argv.includes("--json");
const policyPath = arg("--policy", join(ROOT, "policies", "example-policy.json"));
const corpusPath = arg("--corpus", join(ROOT, "corpus.json"));

const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const results = corpus.payloads.map((p) => {
  const decision = enforce(policy, { role: p.role, ...p.attemptedCall });
  return {
    id: p.id,
    fromIncident: p.fromIncident,
    name: p.name,
    subverted: true, // by assumption: the injection won at the model layer
    executed: decision.allowed,
    refusal: decision.allowed ? null : decision.refusal,
    reason: decision.reason,
    expectedRefusal: p.expectedRefusal,
    matchedExpectation: decision.allowed ? false : decision.refusal === p.expectedRefusal,
  };
});

const executed = results.filter((r) => r.executed).length;
const byRefusal = {};
for (const r of results) if (!r.executed) byRefusal[r.refusal] = (byRefusal[r.refusal] ?? 0) + 1;

if (asJson) {
  process.stdout.write(JSON.stringify({ policy: policy.name, total: results.length, subverted: results.length, executed, byRefusal, results }, null, 2) + "\n");
} else {
  process.stdout.write(`\nInjectionGauntlet — structural enforcement vs. LLM gullibility\n`);
  process.stdout.write(`Policy: ${policy.name}\n\n`);
  for (const r of results) {
    const verdict = r.executed ? "EXECUTED ⚠" : `blocked (${r.refusal})`;
    process.stdout.write(`  ${r.id}  ${r.name}\n`);
    process.stdout.write(`        from ${r.fromIncident} · agent subverted: YES · tool executed: ${r.executed ? "YES" : "NO"} · ${verdict}\n`);
  }
  const refusalSummary = Object.entries(byRefusal).map(([k, v]) => `${v} by ${k}`).join(", ");
  process.stdout.write(`\n  Agent fully subverted by injection: ${results.length}/${results.length}\n`);
  process.stdout.write(`  Tool calls that actually executed:  ${executed}/${results.length}\n`);
  process.stdout.write(`  Blocked: ${refusalSummary}\n`);
  process.stdout.write(executed === 0
    ? `\n  ✓ Enforcement held: every injection succeeded at the model layer and none reached a tool.\n`
    : `\n  ⚠ ${executed} call(s) executed — tighten the policy.\n`);
}

process.exit(executed === 0 ? 0 : 1);
