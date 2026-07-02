#!/usr/bin/env node
/**
 * agent-proof — a standalone, zero-trust, zero-dependency verifier for
 * Agent Action Proof Receipt bundles. It re-implements verification from the
 * public spec; it does not import the producer's server or touch a database.
 *
 * Usage:
 *   agent-proof verify <bundle.json> [--key <pubkey.pem>] [--json] [--quiet]
 *   agent-proof verify -            (read the bundle from stdin)
 *   agent-proof --help
 *
 * Exit code 0 if the bundle verifies, 1 otherwise (2 on usage error).
 */

import { readFileSync } from "node:fs";

import { nodeCrypto } from "./node-crypto.js";
import { verifyBundle } from "./verify-core.js";

const HELP = `agent-proof — verify an Agent Action Proof Receipt bundle, offline.

USAGE
  agent-proof verify <bundle.json> [options]
  agent-proof verify -                 read the bundle from stdin

OPTIONS
  --key <pubkey.pem>   pin the expected instance public key; a bundle re-signed
                       with any other key is rejected (recommended)
  --json               print the machine-readable result object
  --quiet              print nothing; communicate only via exit code
  -h, --help           show this help

EXIT CODES
  0  bundle verified    1  verification failed    2  usage error

This tool trusts nothing but the bytes you give it. It needs no network and no
access to the system that produced the bundle. Spec: docs/audit-spec.md.`;

function readStdin() {
  return readFileSync(0, "utf8");
}

function parse(argv) {
  const opts = { json: false, quiet: false, key: null, file: null, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--key") opts.key = argv[++i];
    else rest.push(a);
  }
  // rest[0] is the command ("verify"); rest[1] is the file (or "-").
  if (rest[0] === "verify") opts.file = rest[1] ?? null;
  else if (rest.length && rest[0] !== "verify") opts.unknownCommand = rest[0];
  return opts;
}

async function main() {
  const opts = parse(process.argv.slice(2));

  if (opts.help || process.argv.length <= 2) {
    process.stdout.write(HELP + "\n");
    process.exit(opts.help ? 0 : 2);
  }
  if (opts.unknownCommand) {
    process.stderr.write(`unknown command "${opts.unknownCommand}" (expected "verify")\n`);
    process.exit(2);
  }
  if (!opts.file) {
    process.stderr.write('usage: agent-proof verify <bundle.json> (or "-" for stdin)\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = opts.file === "-" ? readStdin() : readFileSync(opts.file, "utf8");
  } catch (e) {
    process.stderr.write(`cannot read ${opts.file}: ${e.message}\n`);
    process.exit(2);
  }

  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`not valid JSON: ${e.message}\n`);
    process.exit(2);
  }

  let expectedPublicKeyPem;
  if (opts.key) {
    try {
      expectedPublicKeyPem = readFileSync(opts.key, "utf8");
    } catch (e) {
      process.stderr.write(`cannot read key ${opts.key}: ${e.message}\n`);
      process.exit(2);
    }
  }

  const result = await verifyBundle(bundle, nodeCrypto, { expectedPublicKeyPem });

  if (opts.json) {
    if (!opts.quiet) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.ok ? 0 : 1);
  }

  if (!opts.quiet) {
    if (result.ok) {
      const kind = result.bundleKind === "full" ? "full chain (genesis-rooted)" : "single run";
      process.stdout.write(`PASS  ${result.count} events, ${kind}\n`);
      process.stdout.write(`      head ${result.headHash}\n`);
      if (result.keyFingerprint) {
        process.stdout.write(`      key  sha256:${result.keyFingerprint}\n`);
      }
      if (opts.key) process.stdout.write(`      key pinned and matched\n`);
    } else {
      process.stdout.write(`FAIL  ${result.reason}\n`);
      if (result.failedSeq) process.stdout.write(`      first failing event: seq ${result.failedSeq}\n`);
    }
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(2);
});
