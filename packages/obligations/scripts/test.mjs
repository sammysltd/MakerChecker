/**
 * Tests the obligations checker against (a) the proof-verifier's real signed
 * conformance bundle, and (b) a freshly-built signed bundle with no approvals,
 * so all three statuses (MET, NOT_EVIDENCED, NOT_APPLICABLE) are exercised on a
 * verifying chain.
 */

import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../proof-verifier/src/canonical-json.js";
import { checkObligations, STATUS } from "../src/checker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, "..", "..", "proof-verifier", "vectors");
const profile = (id) => JSON.parse(readFileSync(join(HERE, "..", "profiles", `${id}.json`), "utf8"));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const GENESIS_PREFIX = "makerchecker-genesis:";

let failures = 0;
const check = (cond, msg) => { if (cond) { console.log(`  ok  ${msg}`); } else { console.error(`  FAIL ${msg}`); failures++; } };

// ---- Build a minimal signed full bundle with NO approvals ----
function buildNoApprovalBundle() {
  const instanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const hashInput = (e) => ({ id: e.id, occurredAt: e.occurred_at, actor: e.actor, eventType: e.event_type, entityType: e.entity_type, entityId: e.entity_id, runId: e.run_id, payload: e.payload, prevHash: e.prev_hash });
  const specs = [
    { id: "g", occurred_at: "2026-01-01T00:00:00.000Z", actor: { kind: "system" }, event_type: "audit.genesis", payload: { instanceId } },
    { id: "s", occurred_at: "2026-01-01T00:00:01.000Z", actor: { kind: "agent", id: "a1" }, event_type: "skill.invoked", run_id: "r1", payload: { skill: "lookup@1" } },
  ];
  let prev = sha(GENESIS_PREFIX + instanceId);
  const events = specs.map((s, i) => {
    const e = { seq: String(i + 1), id: s.id, occurred_at: s.occurred_at, actor: s.actor, event_type: s.event_type, entity_type: null, entity_id: null, run_id: s.run_id ?? null, payload: s.payload, prev_hash: prev };
    e.hash = sha(canonicalJson(hashInput(e)));
    prev = e.hash;
    return e;
  });
  const unsigned = { bundleKind: "full", schemaVersion: 1, instanceId, exportedAt: "2026-01-01T01:00:00.000Z", runId: null, count: events.length, firstSeq: "1", lastSeq: String(events.length), headHash: events.at(-1).hash, eventHashesDigest: sha(events.map((e) => e.hash).join("\n")), publicKeyPem };
  const signingString = canonicalJson({ bundleKind: unsigned.bundleKind, schemaVersion: unsigned.schemaVersion, instanceId, exportedAt: unsigned.exportedAt, runId: null, count: unsigned.count, firstSeq: unsigned.firstSeq, lastSeq: unsigned.lastSeq, headHash: unsigned.headHash, eventHashesDigest: unsigned.eventHashesDigest });
  const signature = edSign(null, Buffer.from(signingString, "utf8"), privateKey).toString("base64");
  return { manifest: { ...unsigned, signature }, events };
}

// ---- Test A: real signed bundle with approvals, against Part 11 ----
const validFull = JSON.parse(readFileSync(join(VECTORS, "valid-full.json"), "utf8"));
const a = await checkObligations(validFull, profile("part-11"));
console.log("Test A — valid-full.json vs Part 11:");
check(a.reliable === true, "chain verifies (findings reliable)");
const byId = Object.fromEntries(a.clauses.map((c) => [c.id, c]));
check(byId["11.10(d)"].status === STATUS.MET && byId["11.10(d)"].citedSeqs.length > 0, "11.10(d) access control MET with citations");
check(byId["11.10(e)"].status === STATUS.MET, "11.10(e) audit trail MET");
check(byId["11.50"].status === STATUS.MET, "11.50 signature manifestation MET (a gate was decided)");
check(a.summary.MET >= 6, `most clauses MET (${a.summary.MET} met)`);

// ---- Test B: signed bundle with NO approvals, against Part 11 ----
const b = await checkObligations(buildNoApprovalBundle(), profile("part-11"));
console.log("Test B — minimal no-approval signed bundle vs Part 11:");
check(b.reliable === true, "chain verifies");
const bById = Object.fromEntries(b.clauses.map((c) => [c.id, c]));
check(bById["11.50"].status === STATUS.NOT_APPLICABLE, "11.50 NOT_APPLICABLE (no approval was requested)");
check(bById["11.10(f)"].status === STATUS.NOT_APPLICABLE, "11.10(f) sequencing NOT_APPLICABLE");
check(bById["11.10(d)"].status === STATUS.NOT_EVIDENCED, "11.10(d) NOT_EVIDENCED (no deny/grant in this run)");
check(bById["11.10(e)"].status === STATUS.MET, "11.10(e) audit trail MET (genesis + recorded action on a verified chain)");
check(b.summary.NOT_APPLICABLE >= 2 && b.summary.NOT_EVIDENCED >= 1, "all three statuses exercised");

// ---- Test C: every profile loads and runs ----
for (const id of ["part-11", "annex-11", "gamp5", "hipaa-164-312"]) {
  const r = await checkObligations(validFull, profile(id));
  check(r.clauses.length > 0 && r.reliable, `${id} profile runs and verifies`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
