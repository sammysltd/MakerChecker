/**
 * Tests the validation-kit fail-closed:
 *   A  the real signed bundle (which never hits a limit) leaves URS-004
 *      unexercised => NOT QUALIFIED, and the CLI exits 1;
 *   A2 an explicit waiver (--waive/--reason) qualifies WITH a recorded deviation;
 *   A3 a waiver never rescues a requirement whose tests executed and failed;
 *   B  a tampered bundle never qualifies;
 *   C  a signed challenge run that exercises every URS (including an over-limit
 *      refusal for URS-004) fully qualifies with no waivers.
 */

import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../proof-verifier/src/canonical-json.js";
import { generateValidation, RESULT } from "../src/generate.js";
import { renderReport } from "../src/report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, "..", "..", "proof-verifier", "vectors");
const CLI = join(HERE, "..", "src", "cli.js");
const bundle = JSON.parse(readFileSync(join(VECTORS, "valid-full.json"), "utf8"));
const tampered = JSON.parse(readFileSync(join(VECTORS, "tampered-payload.json"), "utf8"));
const protocol = JSON.parse(readFileSync(join(HERE, "..", "protocols", "agent-governance-baseline.json"), "utf8"));

let failures = 0;
const check = (cond, msg) => { if (cond) console.log(`  ok  ${msg}`); else { console.error(`  FAIL ${msg}`); failures++; } };

// ---- Build a minimal signed full bundle from event specs ----
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const GENESIS_PREFIX = "makerchecker-genesis:";
function buildSignedBundle(specs) {
  const instanceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const hashInput = (e) => ({ id: e.id, occurredAt: e.occurred_at, actor: e.actor, eventType: e.event_type, entityType: e.entity_type, entityId: e.entity_id, runId: e.run_id, payload: e.payload, prevHash: e.prev_hash });
  let prev = sha(GENESIS_PREFIX + instanceId);
  const events = specs.map((s, i) => {
    const e = { seq: String(i + 1), id: `e${i + 1}`, occurred_at: `2026-01-01T00:00:0${i}.000Z`, actor: s.actor ?? { kind: "system" }, event_type: s.event_type, entity_type: null, entity_id: null, run_id: s.run_id ?? null, payload: s.payload ?? {}, prev_hash: prev };
    e.hash = sha(canonicalJson(hashInput(e)));
    prev = e.hash;
    return e;
  });
  const unsigned = { bundleKind: "full", schemaVersion: 1, instanceId, exportedAt: "2026-01-01T01:00:00.000Z", runId: null, count: events.length, firstSeq: "1", lastSeq: String(events.length), headHash: events.at(-1).hash, eventHashesDigest: sha(events.map((e) => e.hash).join("\n")), publicKeyPem };
  const signingString = canonicalJson({ bundleKind: unsigned.bundleKind, schemaVersion: unsigned.schemaVersion, instanceId, exportedAt: unsigned.exportedAt, runId: null, count: unsigned.count, firstSeq: unsigned.firstSeq, lastSeq: unsigned.lastSeq, headHash: unsigned.headHash, eventHashesDigest: unsigned.eventHashesDigest });
  const signature = edSign(null, Buffer.from(signingString, "utf8"), privateKey).toString("base64");
  return { manifest: { ...unsigned, signature }, events };
}

// ---- A: a valid governed run that never hits a limit does NOT qualify ----
console.log("Test A — unexercised URS-004 fails closed:");
const v = await generateValidation(bundle, protocol);
const byId = Object.fromEntries(v.tests.map((t) => [t.id, t]));
check(v.reliable, "chain verifies");
check(byId["IQ-001"].result === RESULT.PASS, "IQ-001 genesis + chain PASS");
check(byId["OQ-001"].result === RESULT.PASS && byId["OQ-001"].citedSeqs.length > 0, "OQ-001 deny-by-default PASS with cited evidence");
check(byId["OQ-002"].result === RESULT.PASS, "OQ-002 high-risk gate PASS");
check(byId["PQ-001"].result === RESULT.PASS, "PQ-001 end-to-end run PASS");
check(byId["OQ-004"].result === RESULT.NOT_APPLICABLE, "OQ-004 limits NOT_APPLICABLE (no limit hit in this run)");
check(v.summary.FAIL === 0, "no executed test failed");
const rtmById = Object.fromEntries(v.rtm.map((r) => [r.urs, r]));
check(rtmById["URS-001"].covered, "RTM: URS-001 covered");
check(rtmById["URS-003"].covered, "RTM: URS-003 (audit trail) covered");
check(rtmById["URS-004"].untested && !rtmById["URS-004"].waived, "RTM: URS-004 not exercised and not waived");
check(v.qualified === false, "untested URS-004 => NOT QUALIFIED (fail-closed)");
const mdA = renderReport(v, { generatedAt: "2026-06-29" });
check(mdA.includes("NOT QUALIFIED"), "report says NOT QUALIFIED");
check(mdA.includes("**not exercised**"), "RTM flags the unexercised requirement");
for (const section of ["Installation Qualification", "Operational Qualification", "Performance Qualification", "Requirements Traceability Matrix", "Deviations"]) {
  check(mdA.includes(section), `report contains "${section}"`);
}

// ---- A2: the same run with an explicit waiver qualifies WITH a deviation ----
console.log("Test A2 — waived URS-004 qualifies with a recorded deviation:");
const REASON = "Fail-closed limits challenge scheduled for OQ round 2 (CAPA-114)";
const w = await generateValidation(bundle, protocol, { waivers: [{ urs: "URS-004", reason: REASON }] });
check(w.qualified === true, "waived URS-004 => QUALIFIED (with deviations)");
check(w.summary.requirementsWaived === 1, "summary counts 1 waived requirement");
const mdW = renderReport(w);
check(mdW.includes("QUALIFIED (with deviations)"), "report says QUALIFIED (with deviations)");
check(mdW.includes(REASON), "waiver reason recorded verbatim in the Deviations section");

// ---- A3: a waiver cannot rescue a requirement whose tests executed and failed ----
console.log("Test A3 — waiver never rescues a failed requirement:");
const failingProtocol = {
  ...protocol,
  urs: [...protocol.urs, { id: "URS-099", text: "synthetic failing requirement", risk: "high" }],
  fs: [...protocol.fs, { id: "FS-099", urs: ["URS-099"], text: "synthetic" }],
  tests: [...protocol.tests, { id: "OQ-099", stage: "OQ", fs: ["FS-099"], title: "synthetic", procedure: "-", expected: "-", applicableWhen: "always", evidence: { eventType: "no.such.event" } }],
};
const f = await generateValidation(bundle, failingProtocol, { waivers: [{ urs: "URS-099", reason: "attempted waiver of a FAILED test" }, { urs: "URS-004", reason: REASON }] });
check(f.qualified === false, "failed OQ-099 keeps the system NOT QUALIFIED despite the waiver");
check(f.rtm.find((r) => r.urs === "URS-099").waived === false, "waiver not applied to an executed-and-failed requirement");

// ---- B: a tampered bundle must NOT qualify ----
console.log("Test B — tampered bundle:");
const t = await generateValidation(tampered, protocol);
check(t.reliable === false, "tampered chain does not verify");
check(t.qualified === false, "tampered bundle NOT qualified");
check(renderReport(t).includes("NOT QUALIFIED"), "tampered report says NOT QUALIFIED");

// ---- C: a challenge run exercising every URS fully qualifies, no waivers ----
console.log("Test C — challenge run exercises URS-004 and fully qualifies:");
const challenge = buildSignedBundle([
  { event_type: "audit.genesis", payload: { instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
  { event_type: "run.started", run_id: "r1", payload: { flow: "oq-challenge" } },
  { event_type: "enforcement.blocked", run_id: "r1", payload: { code: "skill_not_granted", skill: "e2b-submit@1.0.0" } },
  { event_type: "approval.requested", run_id: "r1", payload: { gate: "medical-review" } },
  { event_type: "approval.decided", run_id: "r1", actor: { kind: "user", id: "user-0002" }, payload: { decision: "approved", decider: "user-0002", reason: "challenge approved" } },
  { event_type: "enforcement.blocked", run_id: "r1", payload: { code: "limit_amount", limit: 1000, attempted: 5000 } },
  { event_type: "skill.invoked", run_id: "r1", actor: { kind: "agent", id: "a1" }, payload: { skill: "lookup@1" } },
  { event_type: "run.completed", run_id: "r1", payload: { status: "completed" } },
]);
const c = await generateValidation(challenge, protocol);
const cById = Object.fromEntries(c.tests.map((x) => [x.id, x]));
check(c.reliable, "challenge chain verifies");
check(cById["OQ-004"].result === RESULT.PASS && cById["OQ-004"].citedSeqs.length > 0, "OQ-004 fail-closed limits PASS with cited evidence");
check(c.rtm.every((r) => r.covered), "every URS covered (including URS-004)");
check(c.qualified === true && c.summary.requirementsWaived === 0, "challenge run QUALIFIED with zero waivers");

// ---- D: CLI exit codes are fail-closed ----
console.log("Test D — CLI exit codes:");
const run = (...args) => spawnSync(process.execPath, [CLI, "run", "--bundle", join(VECTORS, "valid-full.json"), "--protocol", "agent-governance-baseline", ...args], { encoding: "utf8" });
const plain = run();
check(plain.status === 1, `unwaived untested URS exits 1 (got ${plain.status})`);
check(plain.stdout.includes("NOT QUALIFIED"), "CLI report says NOT QUALIFIED");
const waived = run("--waive", "URS-004", "--reason", REASON);
check(waived.status === 0, `waived run exits 0 (got ${waived.status})`);
check(waived.stdout.includes("QUALIFIED (with deviations)") && waived.stdout.includes(REASON), "CLI report prints the deviation with its reason");
const noReason = run("--waive", "URS-004");
check(noReason.status === 2, `--waive without --reason is a usage error, exit 2 (got ${noReason.status})`);
const badUrs = run("--waive", "URS-999", "--reason", "typo");
check(badUrs.status === 2, `--waive of an unknown URS is an error, exit 2 (got ${badUrs.status})`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
