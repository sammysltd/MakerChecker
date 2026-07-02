# Agent Action Proof Receipt (AAPR) — version 1

**Status:** Draft standard, version 1. Editor: MakerChecker. Reference producer:
MakerChecker. Reference verifier: [`@makerchecker/proof-verifier`](../../packages/proof-verifier).

This document specifies a vendor-neutral, portable format for **proving that an
AI agent's actions were governed and recorded**, such that any third party — an
auditor, a regulator's examiner, a counterparty — can verify the proof offline,
in any language, with no access to the producing system.

It is a generalization of MakerChecker's audit chain
([docs/audit-spec.md](../../docs/audit-spec.md)). MakerChecker is *a* producer of
AAPR receipts, not *the* format. Any system that emits a conforming receipt and
passes the [conformance vectors](#7-conformance) may describe itself as
"Agent-Proof compatible, v1."

## 0. Why a standard

The value of an audit record is that someone can check it **without trusting the
party that produced it**. That property only holds if the format is open, the
verification is reproducible from this document alone, and the same shape is used
across producers so a verifier (and an auditor's habit) is portable. A format
that an examiner learns to expect is more durable than any single
implementation: copying the schema makes you an implementer of the standard, not
a competitor to it.

## 1. Terminology

- **Event** — one recorded fact about an agent action or a governance decision
  (a tool call, a denied call, an approval, a run boundary).
- **Chain** — the append-only sequence of events, linked by hash.
- **Bundle** — a signed, self-contained export of some or all of the chain,
  consisting of a `manifest` and an `events` array.
- **Producer** — the system that records events and emits bundles.
- **Verifier** — any program that checks a bundle against this specification.
- **Instance** — one producer deployment, identified by a UUID established at
  initialization and bound into the chain's genesis.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

## 2. Canonicalization

All hashing and signing operate on **RFC 8785 (JSON Canonicalization Scheme)**
serializations, UTF-8 encoded. A conforming implementation MUST apply exactly
these rules (they are the contract; a library dependency that drifts breaks
reproducibility):

- No insignificant whitespace.
- Object keys sorted by UTF-16 code units (plain lexicographic code-unit sort).
- Numbers serialized per the ECMAScript `Number::toString` algorithm (what
  `JSON.stringify` produces). Non-finite numbers are invalid.
- Object members whose value is `undefined` are omitted; `null` serializes as
  `null`.

## 3. Event hash

Each event carries a `hash`:

```
hash = SHA-256( canonicalJson({
  id:         <event uuid, string>,
  occurredAt: <timestamp as stored text>,
  actor:      <actor object>,
  eventType:  <string>,
  entityType: <string or null>,
  entityId:   <uuid string or null>,
  runId:      <uuid string or null>,
  payload:    <payload object>,
  prevHash:   <hex string>
}) )            -> hex-encoded, lowercase
```

- The hashed object uses exactly these camelCase keys. After canonical sorting
  the member order is: `actor`, `entityId`, `entityType`, `eventType`, `id`,
  `occurredAt`, `payload`, `prevHash`, `runId`.
- `occurredAt` MUST be stored and hashed as text (ISO 8601 UTC, e.g.
  `2026-06-12T09:30:00.123Z`), byte-for-byte as stored. Timestamp column types
  reformat on round-trip and break recomputation; fixed-format UTC ISO strings
  also sort lexicographically in chronological order.
- A storage-order field (`seq` in the wire format) MUST NOT be included in the
  hash. Chain order is defined solely by `prevHash` linkage; verifiers MUST NOT
  assume storage-order values are contiguous.

## 4. Genesis and chain rule

```
genesisPrevHash = SHA-256( "makerchecker-genesis:" + instanceId )   -> hex, lowercase
```

- The first event in a chain MUST have `eventType = "audit.genesis"`,
  `prevHash = genesisPrevHash`, and `payload = { "instanceId": <instanceId> }`.
- Every subsequent event's `prevHash` MUST equal the `hash` of the immediately
  preceding event.

> Version 1 fixes the genesis label string for compatibility with the reference
> producer. A future version MAY parameterize the producer prefix; until then a
> verifier uses the label above.

## 5. Bundles

A bundle is a JSON document `{ manifest, events }`.

`events` is the array of event rows in storage order. Each row carries `seq`
(storage-order string), `id`, `occurred_at`, `actor`, `event_type`,
`entity_type`, `entity_id`, `run_id`, `payload`, `prev_hash`, `hash`
(snake_case on the wire; mapped to the camelCase hash input of §3 for hashing).

### Manifest

| Field | Meaning |
|---|---|
| `bundleKind` | `"full"` (entire chain) or `"run"` (one run's events) |
| `schemaVersion` | format/domain schema version (this spec: `1`) |
| `instanceId` | the producing instance's UUID |
| `exportedAt` | ISO 8601 export timestamp |
| `runId` | the run UUID for `run` bundles, else `null` |
| `count` | number of events in the bundle |
| `firstSeq`, `lastSeq` | `seq` of first/last event (strings), `null` if empty |
| `headHash` | `hash` of the last event, `null` if empty |
| `eventHashesDigest` | `SHA-256( join(event hashes in order, "\n") )`, hex |
| `publicKeyPem` | the instance's Ed25519 public key, SPKI PEM |
| `signature` | Ed25519 signature, base64 |

### Signature

The signature is Ed25519 over the UTF-8 bytes of the **canonical signing
string**: the RFC 8785 canonical JSON of exactly these manifest fields, in this
object (`publicKeyPem` and `signature` are excluded):

```
{ bundleKind, schemaVersion, instanceId, exportedAt, runId,
  count, firstSeq, lastSeq, headHash, eventHashesDigest }
```

The signing key is the instance's Ed25519 keypair; the private key MUST NOT
leave the producer. Key authenticity is established out of band: a relying party
obtains the instance public key through a trusted channel once and pins it. A
bundle proves integrity and origin under its embedded key; it cannot prove which
key is legitimate.

## 6. Verification

Given a bundle and no producer access, a conforming verifier MUST perform, and
reject on any failure:

1. **Signature.** Rebuild the canonical signing string from the manifest;
   verify `signature` with `publicKeyPem`.
2. **Count.** `events.length == manifest.count`.
3. **Hash-set digest.** `SHA-256( join(events[i].hash, "\n") ) == eventHashesDigest`.
   This binds the exact event set and order into the signature.
4. **Per-event hashes.** Recompute every event's hash per §3; each MUST equal
   its stored `hash`.
5. **Linkage.**
   - **Full bundles:** the first event's `prev_hash` MUST equal
     `genesisPrevHash(instanceId)`, and each subsequent `prev_hash` MUST equal
     the previous event's `hash`. A full bundle thus proves completeness:
     nothing removed, inserted, or reordered.
   - **Run bundles:** linkage is not checked (a run's events interleave with the
     global chain). Instead `manifest.runId` MUST be non-null and every event's
     `run_id` MUST equal it. Each event's `run_id` is bound into its own hash,
     so a foreign event cannot be relabelled without failing step 4. A run
     bundle does not prove completeness against omission, nor resist a
     key-holding insider fabricating self-consistent events for the run; use a
     full bundle for those guarantees.
6. **Head and bounds.** The last event's `hash` MUST equal `headHash`, and
   `firstSeq`/`lastSeq` MUST equal the first/last event's `seq`.
7. **Key pinning (optional, recommended).** If the relying party has pinned an
   expected instance public key, the verifier MUST reject a bundle whose
   `publicKeyPem` is not that key, even if internally self-consistent.

## 7. Conformance

A producer or verifier self-certifies as **Agent-Proof compatible, v1** by
passing the public conformance corpus in
[`packages/proof-verifier/vectors/`](../../packages/proof-verifier/vectors):
valid full and run bundles plus adversarial variants (tampered payload,
corrupted signature, truncation, reordering, a re-signed foreign-run splice, and
a wrong-key forgery), each with the verdict in
[`vectors/index.json`](../../packages/proof-verifier/vectors/index.json). A
verifier MUST return the listed verdict for every case.

```bash
cd packages/proof-verifier && npm test   # rebuilds vectors and asserts all verdicts
```

The reference verifier is cross-checked to be byte-identical to the reference
producer's own primitives, so "verify from this spec alone" is a tested fact.

## 8. The proof badge

A system that passes §7 MAY display the compatibility badge and link it to an
independent verifier. The badge is a pointer to verifiability, not a claim of
trust: a reader can always re-verify a bundle themselves.

```
[![Agent-Proof compatible v1](https://makerchecker.ai/agent-proof/badge-v1.svg)](https://makerchecker.ai/agent-proof/verify)
```

## 9. Versioning

This document is version 1 (`schemaVersion: 1`). Changes that alter how any byte
is hashed or signed require a new version number. Additive manifest fields that
do not enter the signing string of §5 are permitted within version 1. Report
weaknesses or propose changes via [SECURITY.md](../../SECURITY.md) and the
project issue tracker.
