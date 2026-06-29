#!/usr/bin/env node
/**
 * mc-obligations — deterministic, offline mapping of a signed audit bundle to a
 * named regulatory obligation profile. Emits, per clause, MET / NOT_EVIDENCED /
 * NOT_APPLICABLE with the citing seq numbers.
 *
 * Usage:
 *   mc-obligations check --bundle <bundle.json> --profile <id|path> [--key <pem>] [--json] [--strict]
 *   mc-obligations list-profiles
 *
 * Exit: 0 ok; 1 if the chain did not verify (or --strict and any clause
 * NOT_EVIDENCED); 2 usage error.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkObligations, STATUS } from "./checker.js";

const PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "profiles");

const HELP = `mc-obligations — map a signed audit bundle to a regulatory obligation profile.

USAGE
  mc-obligations check --bundle <bundle.json> --profile <id|path> [options]
  mc-obligations list-profiles

OPTIONS
  --bundle <file>    the signed audit bundle to assess (required)
  --profile <id>     a built-in profile id (e.g. part-11) or a path to a profile JSON
  --key <pubkey.pem> pin the instance public key when verifying the bundle
  --json             print the machine-readable report
  --strict           exit non-zero if any applicable clause is NOT_EVIDENCED
  -h, --help         show this help

Deterministic and offline: no LLM, no network, no producer access.`;

function listProfiles() {
  return readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

function resolveProfile(idOrPath) {
  const builtin = join(PROFILES_DIR, `${idOrPath}.json`);
  for (const p of [builtin, resolve(idOrPath)]) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* try next */
    }
  }
  return null;
}

function parse(argv) {
  const o = { cmd: argv[0], bundle: null, profile: null, key: null, json: false, strict: false, help: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a === "--strict") o.strict = true;
    else if (a === "--bundle") o.bundle = argv[++i];
    else if (a === "--profile") o.profile = argv[++i];
    else if (a === "--key") o.key = argv[++i];
  }
  return o;
}

const ICON = { [STATUS.MET]: "✓", [STATUS.NOT_EVIDENCED]: "✗", [STATUS.NOT_APPLICABLE]: "–" };

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help || !o.cmd) { process.stdout.write(HELP + "\n"); process.exit(o.help ? 0 : 2); }

  if (o.cmd === "list-profiles") {
    process.stdout.write(listProfiles().join("\n") + "\n");
    process.exit(0);
  }
  if (o.cmd !== "check") { process.stderr.write(`unknown command "${o.cmd}"\n`); process.exit(2); }
  if (!o.bundle || !o.profile) { process.stderr.write("usage: mc-obligations check --bundle <f> --profile <id>\n"); process.exit(2); }

  let bundle;
  try { bundle = JSON.parse(readFileSync(o.bundle, "utf8")); }
  catch (e) { process.stderr.write(`cannot read bundle: ${e.message}\n`); process.exit(2); }

  const profile = resolveProfile(o.profile);
  if (!profile) { process.stderr.write(`unknown profile "${o.profile}". Available: ${listProfiles().join(", ")}\n`); process.exit(2); }

  const opts = {};
  if (o.key) { try { opts.expectedPublicKeyPem = readFileSync(o.key, "utf8"); } catch (e) { process.stderr.write(`cannot read key: ${e.message}\n`); process.exit(2); } }

  const report = await checkObligations(bundle, profile, opts);

  if (o.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`\n${report.profile.framework}\n`);
    process.stdout.write(`Bundle: ${report.chain.verified ? `chain VERIFIED (${report.chain.count} events)` : `chain DID NOT VERIFY — ${report.chain.reason}`}\n`);
    if (!report.reliable) process.stdout.write("WARNING: the chain did not verify; the findings below must not be relied upon.\n");
    process.stdout.write("\n");
    for (const c of report.clauses) {
      process.stdout.write(`  ${ICON[c.status]} ${c.id}  ${c.status}${c.citedSeqs.length ? `  (seq ${c.citedSeqs.join(", ")})` : ""}\n`);
      process.stdout.write(`      ${c.title}\n`);
    }
    const s = report.summary;
    process.stdout.write(`\n  ${s.MET} met, ${s.NOT_EVIDENCED} not-evidenced, ${s.NOT_APPLICABLE} not-applicable\n`);
  }

  if (!report.chain.verified) process.exit(1);
  if (o.strict && report.summary.NOT_EVIDENCED > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(2); });
