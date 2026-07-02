/**
 * Generates the public conformance-vector corpus for the proof verifier.
 *
 * It builds a realistic, genesis-rooted audit chain using the SAME rules the
 * producer uses (RFC 8785 canonical JSON + SHA-256 event hashes + an Ed25519
 * manifest signature), exports a full bundle and a run bundle, then derives a
 * set of tampered/forged variants with the verdict a conformant verifier must
 * return. The private signing key is generated here and discarded; only the
 * public key travels in the bundles (and is written out for pin-test cases).
 *
 * Any implementation in any language can run these vectors and self-certify by
 * matching the verdicts in vectors/index.json.
 *
 * Re-generate with: npm run build:vectors
 */

import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/canonical-json.js";

const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const SCHEMA_VERSION = 1;
const GENESIS_PREFIX = "makerchecker-genesis:";

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function hashInput(e) {
  return {
    id: e.id,
    occurredAt: e.occurred_at,
    actor: e.actor,
    eventType: e.event_type,
    entityType: e.entity_type,
    entityId: e.entity_id,
    runId: e.run_id,
    payload: e.payload,
    prevHash: e.prev_hash,
  };
}

const eventHash = (e) => sha256Hex(canonicalJson(hashInput(e)));

/** Builds a chain of events, assigning seq, prev_hash and hash in order. */
function buildChain(instanceId, specs) {
  const genesisPrev = sha256Hex(GENESIS_PREFIX + instanceId);
  let prev = genesisPrev;
  const events = [];
  specs.forEach((spec, i) => {
    const e = {
      seq: String(i + 1),
      id: spec.id,
      occurred_at: spec.occurred_at,
      actor: spec.actor,
      event_type: spec.event_type,
      entity_type: spec.entity_type ?? null,
      entity_id: spec.entity_id ?? null,
      run_id: spec.run_id ?? null,
      payload: spec.payload,
      prev_hash: prev,
    };
    e.hash = eventHash(e);
    prev = e.hash;
    events.push(e);
  });
  return events;
}

function manifestSigningString(m) {
  return canonicalJson({
    bundleKind: m.bundleKind,
    schemaVersion: m.schemaVersion,
    instanceId: m.instanceId,
    exportedAt: m.exportedAt,
    runId: m.runId,
    count: m.count,
    firstSeq: m.firstSeq,
    lastSeq: m.lastSeq,
    headHash: m.headHash,
    eventHashesDigest: m.eventHashesDigest,
  });
}

function makeBundle(events, { bundleKind, instanceId, runId, privateKey, publicKeyPem, exportedAt }) {
  const unsigned = {
    bundleKind,
    schemaVersion: SCHEMA_VERSION,
    instanceId,
    exportedAt,
    runId: runId ?? null,
    count: events.length,
    firstSeq: events[0]?.seq ?? null,
    lastSeq: events[events.length - 1]?.seq ?? null,
    headHash: events[events.length - 1]?.hash ?? null,
    eventHashesDigest: sha256Hex(events.map((e) => e.hash).join("\n")),
    publicKeyPem,
  };
  const signature = edSign(null, Buffer.from(manifestSigningString(unsigned), "utf8"), privateKey).toString("base64");
  return { manifest: { ...unsigned, signature }, events };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

function main() {
  mkdirSync(VECTORS_DIR, { recursive: true });

  const instanceId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const otherRunId = "33333333-3333-4333-8333-333333333333";

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  // A second, unrelated instance key — used to forge an internally-valid bundle
  // signed by the wrong key (the case key pinning is designed to catch).
  const attacker = generateKeyPairSync("ed25519");
  const attackerPubPem = attacker.publicKey.export({ type: "spki", format: "pem" }).toString();

  const t = (n) => `2026-06-12T09:${String(30 + n).padStart(2, "0")}:00.000Z`;
  const agent = { kind: "agent", id: "agent-0001", role: "case-processor" };
  const reviewer = { kind: "user", id: "user-0009", email: "reviewer@example.org" };
  const system = { kind: "system", id: "instance" };

  // A realistic governed run: a high-risk skill is blocked deny-by-default, a
  // named reviewer (not the requester) approves at a gate, then the gated skill
  // runs. Exactly the maker-checker story the audit chain exists to prove.
  const specs = [
    { id: randomUUID(), occurred_at: t(0), actor: system, event_type: "audit.genesis", payload: { instanceId } },
    { id: randomUUID(), occurred_at: t(1), actor: agent, event_type: "run.started", run_id: runId, entity_type: "flow_run", entity_id: runId, payload: { flow: "pv-icsr-processing" } },
    { id: randomUUID(), occurred_at: t(2), actor: agent, event_type: "llm.call", run_id: runId, payload: { model: "claude", tokens: 412 } },
    { id: randomUUID(), occurred_at: t(3), actor: agent, event_type: "enforcement.blocked", run_id: runId, payload: { code: "skill_not_granted", at: "decision", skill: "e2b-submit@1.0.0" } },
    { id: randomUUID(), occurred_at: t(4), actor: agent, event_type: "approval.requested", run_id: runId, entity_type: "approval", entity_id: "appr-1", payload: { gate: "medical-review", skill: "e2b-submit@1.0.0" } },
    { id: randomUUID(), occurred_at: t(5), actor: reviewer, event_type: "approval.decided", run_id: runId, entity_type: "approval", entity_id: "appr-1", payload: { decision: "approved", decider: "user-0009", reason: "Seriousness confirmed for P-4003; file 15-day expedited ICSR per 21 CFR 314.80" } },
    { id: randomUUID(), occurred_at: t(6), actor: agent, event_type: "skill.invoked", run_id: runId, payload: { skill: "e2b-submit@1.0.0", outcome: "filed" } },
    { id: randomUUID(), occurred_at: t(7), actor: agent, event_type: "run.completed", run_id: runId, entity_type: "flow_run", entity_id: runId, payload: { status: "completed" } },
  ];

  const events = buildChain(instanceId, specs);
  const exportedAt = "2026-06-12T10:00:00.000Z";
  const bundleArgs = { instanceId, privateKey, publicKeyPem, exportedAt };

  // ---- Valid bundles -------------------------------------------------------
  const validFull = makeBundle(events, { ...bundleArgs, bundleKind: "full", runId: null });
  const runEvents = events.filter((e) => e.run_id === runId);
  const validRun = makeBundle(runEvents, { ...bundleArgs, bundleKind: "run", runId });

  // ---- Tampered / forged variants ------------------------------------------
  // 1. A payload byte changed, hash left as stored -> per-event hash mismatch.
  const tamperedPayload = clone(validFull);
  tamperedPayload.events[6].payload.outcome = "not-filed";

  // 2. Signature corrupted -> signature invalid.
  const tamperedSignature = clone(validFull);
  const sig = tamperedSignature.manifest.signature;
  tamperedSignature.manifest.signature = (sig[0] === "A" ? "B" : "A") + sig.slice(1);

  // 3. Last event dropped, manifest left intact -> count mismatch.
  const truncated = clone(validFull);
  truncated.events.pop();

  // 4. Two events swapped, manifest left intact -> hash-set digest mismatch.
  const reordered = clone(validFull);
  [reordered.events[2], reordered.events[3]] = [reordered.events[3], reordered.events[2]];

  // 5. A foreign-run event spliced in and the bundle RE-SIGNED so signature,
  //    count, digest and per-event hashes all pass: only the run_id binding
  //    catches it. (Demonstrates the run-bundle integrity guarantee.)
  const foreignSpec = { id: randomUUID(), occurred_at: t(5), actor: agent, event_type: "skill.invoked", run_id: otherRunId, payload: { skill: "x" } };
  const foreignEvent = { seq: "99", entity_type: null, entity_id: null, prev_hash: runEvents[2].hash, ...foreignSpec };
  foreignEvent.hash = eventHash(foreignEvent);
  const foreignEvents = [...runEvents.slice(0, 3), foreignEvent, ...runEvents.slice(3)];
  const foreignRunEvent = makeBundle(foreignEvents, { ...bundleArgs, bundleKind: "run", runId });

  // 6. A complete, internally-valid full bundle signed by the WRONG key. It
  //    PASSES on its own and FAILS only when the real key is pinned.
  const wrongKey = makeBundle(events, { instanceId, privateKey: attacker.privateKey, publicKeyPem: attackerPubPem, exportedAt, bundleKind: "full", runId: null });

  // 7. ill-formed-string: the last event's payload carries an unpaired
  //    surrogate (reachable in production via JSON.parse('{"note":"\ud800"}')).
  //    Its stored hash is over the exact bytes the buggy pre-I-JSON JS producer
  //    emitted (ES2019 JSON.stringify escapes a lone surrogate as \ud800 —
  //    bytes no other language's RFC 8785 implementation reproduces), so this
  //    is precisely the bundle such a producer would have signed. A conformant
  //    verifier must REJECT it as a spec violation (reasonCode
  //    ill_formed_string) — not report tamper, and never "verify" it with
  //    JS-only semantics. The placeholder trick below recreates the legacy
  //    bytes without keeping a second, lenient serializer in the corpus.
  const PLACEHOLDER = "__ILL_FORMED_STRING_PLACEHOLDER__";
  const illSpecs = [
    ...specs,
    { id: randomUUID(), occurred_at: t(8), actor: agent, event_type: "note.recorded", run_id: runId, payload: { note: PLACEHOLDER } },
  ];
  const illEvents = buildChain(instanceId, illSpecs);
  const illLast = illEvents[illEvents.length - 1];
  illLast.hash = sha256Hex(canonicalJson(hashInput(illLast)).replace(`"${PLACEHOLDER}"`, '"\\ud800"'));
  illLast.payload.note = "\ud800"; // the actual lone surrogate ships in the vector
  const illFormedString = makeBundle(illEvents, { ...bundleArgs, bundleKind: "full", runId: null });

  // 8. unicode-literal (POSITIVE): an astral emoji (U+1F600) plus an NFC/NFD
  //    pair (U+00E9 vs U+0065 U+0301), hashed over the literal code points. It
  //    must VERIFY: proving the pipeline emits supplementary characters
  //    literally (RFC 8785 escapes only the mandatory set) and applies no
  //    Unicode normalization (a normalizing implementation would collapse the
  //    NFC/NFD pair and fail the hash).
  const unicodeSpecs = [
    ...specs,
    { id: randomUUID(), occurred_at: t(8), actor: agent, event_type: "note.recorded", run_id: runId, payload: { emoji: "\u{1F600}", nfc: "\u00e9", nfd: "e\u0301" } },
  ];
  const unicodeLiteral = makeBundle(buildChain(instanceId, unicodeSpecs), { ...bundleArgs, bundleKind: "full", runId: null });

  const write = (name, obj) => writeFileSync(join(VECTORS_DIR, name), JSON.stringify(obj, null, 2) + "\n");
  write("valid-full.json", validFull);
  write("valid-run.json", validRun);
  write("tampered-payload.json", tamperedPayload);
  write("tampered-signature.json", tamperedSignature);
  write("truncated.json", truncated);
  write("reordered.json", reordered);
  write("foreign-run-event.json", foreignRunEvent);
  write("wrong-key.json", wrongKey);
  write("ill-formed-string.json", illFormedString);
  write("unicode-literal.json", unicodeLiteral);
  writeFileSync(join(VECTORS_DIR, "instance-pubkey.pem"), publicKeyPem);

  const index = {
    schemaVersion: SCHEMA_VERSION,
    note: "Run every case through your verifier; a conformant verifier matches `expect`. `pinKey` cases pass the named PEM as the expected/pinned instance public key.",
    cases: [
      { file: "valid-full.json", expect: "pass", note: "complete genesis-rooted chain" },
      { file: "valid-run.json", expect: "pass", note: "one run's events, run_id-bound" },
      { file: "valid-full.json", expect: "pass", pinKey: "instance-pubkey.pem", note: "correct key pinned" },
      { file: "tampered-payload.json", expect: "fail", reasonContains: "hash mismatch", note: "an event payload was altered" },
      { file: "tampered-signature.json", expect: "fail", reasonContains: "signature", note: "manifest signature corrupted" },
      { file: "truncated.json", expect: "fail", reasonContains: "count", note: "an event was removed" },
      { file: "reordered.json", expect: "fail", reasonContains: "digest", note: "events reordered" },
      { file: "foreign-run-event.json", expect: "fail", reasonContains: "does not belong to run", note: "re-signed bundle with a foreign-run event spliced in" },
      { file: "wrong-key.json", expect: "pass", note: "internally valid under its own (attacker) key when NOT pinned" },
      { file: "wrong-key.json", expect: "fail", pinKey: "instance-pubkey.pem", reasonContains: "pinned key", note: "same bundle rejected once the real key is pinned" },
      { file: "unicode-literal.json", expect: "pass", note: "astral emoji + NFC/NFD pair hashed over literal code points: no escaping beyond the mandatory set, no Unicode normalization" },
      { file: "ill-formed-string.json", expect: "fail", reasonCode: "ill_formed_string", reasonContains: "ill-formed string", note: "an event payload carries an unpaired surrogate: I-JSON (RFC 7493) spec violation, a verdict distinct from tamper" },
    ],
  };
  writeFileSync(join(VECTORS_DIR, "index.json"), JSON.stringify(index, null, 2) + "\n");

  process.stdout.write(`wrote ${index.cases.length} conformance cases to ${VECTORS_DIR}\n`);
}

main();
