#!/usr/bin/env node
/**
 * mc-validate — generate a Computer System Validation (IQ/OQ/PQ) report and
 * Requirements Traceability Matrix from a signed audit bundle, deterministically.
 *
 * Usage:
 *   mc-validate run --bundle <bundle.json> --protocol <id|path> [--key <pem>] [--out report.md] [--json]
 *               [--waive URS-XXX --reason "..."]...
 *   mc-validate list-protocols
 *
 * Exit: 0 qualified (every requirement covered, or explicitly waived with a
 * recorded reason); 1 not qualified (a failed test, an uncovered or
 * unexercised requirement, or an unverified chain); 2 usage error.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateValidation } from "./generate.js";
import { renderReport } from "./report.js";

const PROTO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "protocols");

const HELP = `mc-validate — generate a CSV (IQ/OQ/PQ) validation report from a signed audit bundle.

USAGE
  mc-validate run --bundle <bundle.json> --protocol <id|path> [options]
  mc-validate list-protocols

OPTIONS
  --bundle <file>    signed audit bundle (required)
  --protocol <id>    built-in protocol id (e.g. agent-governance-baseline) or a path
  --key <pubkey.pem> pin the instance public key when verifying
  --out <file.md>    write the Markdown report to a file
  --json             print the machine-readable result instead of Markdown
  --waive <URS-ID>   waive a requirement this bundle did not exercise (repeatable;
                     each --waive requires a --reason, recorded as a deviation)
  --reason <text>    written reason for the immediately preceding --waive
  -h, --help         show this help

A requirement the bundle never exercised fails closed (exit 1) unless waived.`;

const listProtocols = () => readdirSync(PROTO_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

function resolveProtocol(idOrPath) {
  for (const p of [join(PROTO_DIR, `${idOrPath}.json`), resolve(idOrPath)]) {
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { /* next */ }
  }
  return null;
}

function parse(argv) {
  const o = { cmd: argv[0], bundle: null, protocol: null, key: null, out: null, json: false, help: false, waivers: [], parseError: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a === "--bundle") o.bundle = argv[++i];
    else if (a === "--protocol") o.protocol = argv[++i];
    else if (a === "--key") o.key = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--waive") o.waivers.push({ urs: argv[++i], reason: null });
    else if (a === "--reason") {
      const last = o.waivers[o.waivers.length - 1];
      if (!last || last.reason != null) o.parseError = "--reason must follow a --waive <URS-ID>";
      else last.reason = argv[++i];
    }
  }
  if (!o.parseError) {
    const missing = o.waivers.find((w) => !w.urs || !w.reason || !w.reason.trim());
    if (missing) o.parseError = `--waive ${missing.urs ?? "<URS-ID>"} requires a written --reason "..." (recorded as a deviation)`;
  }
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help || !o.cmd) { process.stdout.write(HELP + "\n"); process.exit(o.help ? 0 : 2); }
  if (o.cmd === "list-protocols") { process.stdout.write(listProtocols().join("\n") + "\n"); process.exit(0); }
  if (o.cmd !== "run") { process.stderr.write(`unknown command "${o.cmd}"\n`); process.exit(2); }
  if (o.parseError) { process.stderr.write(`${o.parseError}\n`); process.exit(2); }
  if (!o.bundle || !o.protocol) { process.stderr.write("usage: mc-validate run --bundle <f> --protocol <id>\n"); process.exit(2); }

  let bundle;
  try { bundle = JSON.parse(readFileSync(o.bundle, "utf8")); }
  catch (e) { process.stderr.write(`cannot read bundle: ${e.message}\n`); process.exit(2); }

  const protocol = resolveProtocol(o.protocol);
  if (!protocol) { process.stderr.write(`unknown protocol "${o.protocol}". Available: ${listProtocols().join(", ")}\n`); process.exit(2); }

  const opts = { waivers: o.waivers };
  if (o.key) { try { opts.expectedPublicKeyPem = readFileSync(o.key, "utf8"); } catch (e) { process.stderr.write(`cannot read key: ${e.message}\n`); process.exit(2); } }

  const result = await generateValidation(bundle, protocol, opts);

  if (o.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const md = renderReport(result);
    const verdict = result.qualified ? (result.summary.requirementsWaived ? "QUALIFIED (with deviations)" : "QUALIFIED") : "NOT QUALIFIED";
    if (o.out) { writeFileSync(o.out, md); process.stdout.write(`wrote ${o.out} — ${verdict}\n`); }
    else process.stdout.write(md);
  }

  process.exit(result.qualified ? 0 : 1);
}

main().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(2); });
