/**
 * Self-test: runs the committed conformance vectors through the verifier and
 * asserts each verdict matches vectors/index.json. This is both the package
 * test and proof that the independent verifier agrees with the spec.
 *
 * Regenerates the vectors first so the corpus and the test never drift.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeCrypto } from "../src/node-crypto.js";
import { verifyBundle } from "../src/verify-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = join(HERE, "..", "vectors");

// Always rebuild the corpus so a code change that would alter a vector is caught.
execFileSync("node", [join(HERE, "build-vectors.mjs")], { stdio: "inherit" });

const index = JSON.parse(readFileSync(join(VECTORS_DIR, "index.json"), "utf8"));
const readBundle = (f) => JSON.parse(readFileSync(join(VECTORS_DIR, f), "utf8"));
const readPem = (f) => readFileSync(join(VECTORS_DIR, f), "utf8");

let passed = 0;
const failures = [];

for (const c of index.cases) {
  const bundle = readBundle(c.file);
  const opts = c.pinKey ? { expectedPublicKeyPem: readPem(c.pinKey) } : {};
  const result = await verifyBundle(bundle, nodeCrypto, opts);
  const got = result.ok ? "pass" : "fail";
  const label = `${c.file}${c.pinKey ? ` [pin ${c.pinKey}]` : ""}`;

  if (got !== c.expect) {
    failures.push(`${label}: expected ${c.expect}, got ${got} (${result.reason ?? "ok"})`);
    continue;
  }
  if (c.expect === "fail" && c.reasonContains && !String(result.reason).includes(c.reasonContains)) {
    failures.push(`${label}: failed as expected but reason "${result.reason}" lacks "${c.reasonContains}"`);
    continue;
  }
  passed += 1;
  process.stdout.write(`  ok  ${label} -> ${got}${got === "fail" ? ` (${result.reason})` : ` (${result.count} events)`}\n`);
}

process.stdout.write(`\n${passed}/${index.cases.length} conformance cases passed\n`);
if (failures.length) {
  process.stderr.write("\nFAILURES:\n" + failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
