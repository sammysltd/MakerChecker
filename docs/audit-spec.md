# Audit chain and export bundle specification

This document specifies MakerChecker's audit chain and signed export bundles precisely enough for an external party (an auditor, a regulator's examiner, a counterparty) to reimplement verification from scratch, in any language, with no access to MakerChecker code or systems. That is the point: the evidence stands on its own.

Status: schema version **1** (`schemaVersion` in bundle manifests). This spec is published precisely so anyone can verify the chain independently and report weaknesses; see [SECURITY.md](../SECURITY.md).

## 1. Canonicalization

All hashing and signing operates on **RFC 8785 (JSON Canonicalization Scheme)** serializations, UTF-8 encoded. MakerChecker vendors its own serializer (`packages/shared/src/canonical-json.ts`) rather than depending on a library, because these exact rules are part of the public contract and must not drift:

- No insignificant whitespace.
- Object keys sorted by UTF-16 code units (plain lexicographic sort of code units).
- Numbers serialized per the ECMAScript `Number::toString` algorithm (what `JSON.stringify` produces). Non-finite numbers are invalid.
- Object members with `undefined` values are omitted; `null` is serialized as `null`.

## 2. Event hash

Each audit event's `hash` is:

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
}) )   -> hex-encoded, lowercase
```

Notes:

- Key names in the hashed object are exactly as above (camelCase). After canonical key sorting the serialized member order is: `actor`, `entityId`, `entityType`, `eventType`, `id`, `occurredAt`, `payload`, `prevHash`, `runId`.
- `occurredAt` is stored in the database as **text** (ISO 8601 UTC, e.g. `2026-06-12T09:30:00.123Z`) and hashed byte-for-byte as stored. It is deliberately not a `timestamptz`: timestamp types reformat on round-trip, which would break exact recomputation. Fixed-format UTC ISO strings sort lexicographically in chronological order.
- **`seq` is excluded from the hash.** `seq` is a database identity column that exists only as storage order; identity columns leave gaps when transactions abort, so `seq` values carry no integrity meaning. Chain order is defined solely by `prevHash` linkage. A verifier must not assume `seq` values are contiguous.

## 3. Genesis and chain rule

The chain is rooted in the instance identity (a UUID created at first migration, `instance.id`):

```
genesisPrevHash = SHA-256( "makerchecker-genesis:" + instanceId )   -> hex, lowercase
```

- The first event in any chain must have `eventType = "audit.genesis"`, `prevHash = genesisPrevHash`, and `payload = {"instanceId": <instanceId>}`.
- For every subsequent event, `prevHash` must equal the `hash` of the immediately preceding event.
- Full-chain verification (`audit verify` CLI, `GET /api/audit/verify`): walk all events in `seq` order; check the genesis root, the `prevHash` linkage, and recompute every event's hash. Any mismatch identifies the first tampered or missing row.

## 4. Export bundles

`makerchecker audit export` produces a JSON document `{ manifest, events }`.

`events` is the array of audit rows in `seq` order, each with fields `seq`, `id`, `occurred_at`, `actor`, `event_type`, `entity_type`, `entity_id`, `run_id`, `payload`, `prev_hash`, `hash` (snake_case, as stored; `seq` is a string).

### Manifest fields

| Field | Meaning |
|---|---|
| `bundleKind` | `"full"` (entire chain) or `"run"` (one run's events) |
| `schemaVersion` | audit/domain schema version (currently `1`) |
| `instanceId` | the exporting instance's UUID |
| `exportedAt` | ISO 8601 export timestamp |
| `runId` | the run UUID for run bundles, else `null` |
| `count` | number of events in the bundle |
| `firstSeq`, `lastSeq` | `seq` of first/last event (strings), `null` if empty |
| `headHash` | `hash` of the last event, `null` if empty |
| `eventHashesDigest` | `SHA-256( join(event hashes in order, "\n") )`, hex |
| `publicKeyPem` | the instance's Ed25519 public key, SPKI PEM |
| `signature` | Ed25519 signature, base64 |

### Signature

The signature is Ed25519 over the UTF-8 bytes of the **canonical signing string**: the RFC 8785 canonical JSON of exactly these manifest fields:

```
{ bundleKind, schemaVersion, instanceId, exportedAt, runId,
  count, firstSeq, lastSeq, headHash, eventHashesDigest }
```

`publicKeyPem` and `signature` itself are excluded from the signing string. The signature is encoded as base64. The signing key is the instance's Ed25519 keypair; the private key never leaves the deployment (`MAKERCHECKER_DATA_DIR/instance_key.pem`, mode 0600), and the public key ships inside every bundle and is recorded in the `instance` table.

Key authenticity is established out of band: a relying party should obtain the instance's public key through a trusted channel once and pin it. The bundle proves integrity and origin under that key; it cannot prove which key is the legitimate one.

## 5. Bundle verification

Given a bundle, with **no database access**:

1. **Signature.** Rebuild the canonical signing string from the manifest (excluding `publicKeyPem`, `signature`); verify `signature` with `publicKeyPem`. Reject on failure.
2. **Count.** `events.length` must equal `manifest.count`.
3. **Hash-set digest.** Recompute `SHA-256( join(events[i].hash, "\n") )`; it must equal `eventHashesDigest`. This binds the exact event set and order to the signature.
4. **Per-event hashes.** Recompute every event's hash per section 2 (mapping snake_case row fields to the camelCase hash input); each must equal the stored `hash`.
5. **Linkage**, this is where full and run bundles differ:
   - **Full bundles:** verify complete genesis-rooted linkage. The first event's `prev_hash` must equal `genesisPrevHash(instanceId)` and each subsequent `prev_hash` must equal the previous event's `hash`. A full bundle therefore proves completeness: nothing was removed from, inserted into, or reordered within the chain.
   - **Run bundles:** linkage is **not** checked, because a run's events are interleaved with other events in the global chain (their `prev_hash` values point at events outside the bundle). Instead, the verifier requires `manifest.runId` to be non-null and **every event's `run_id` to equal it** (each event's `run_id` is bound into its own hash, so a foreign event cannot be relabelled without failing its hash check). Integrity of the set comes from steps 1–4: each event is individually tamper-evident, and the signed digest fixes the exact set and order. A run bundle does not by itself prove that no events were omitted, nor does it defend against a key-holding insider who fabricates self-consistent events for the named run; for completeness or insider-resistant guarantees, verify against a full bundle.
6. **Head.** The last event's `hash` must equal `manifest.headHash`, and `manifest.firstSeq`/`lastSeq` must equal the first/last event's `seq`.
7. **Key pinning (optional).** A bundle proves integrity and origin under the public key embedded in its manifest; it cannot prove which key is legitimate. Obtain the instance public key through a trusted channel once and pin it (`audit verify-bundle --key <pubkey.pem>`); the verifier then rejects a bundle re-signed with any other key.

Reference implementation: `packages/server/src/audit/export.ts` (`verifyBundle`) and `packages/server/src/audit/verify.ts`. Adversarial tests covering tampered rows, broken linkage, and forged manifests live in `packages/server/src/audit/audit.integration.test.ts`.

## 6. Write-path guarantees (context, not verifiable offline)

Inside a deployment, three layers back the chain: append-only triggers on `audit_events` (update/delete/truncate rejected on any connection), `REVOKE UPDATE/DELETE` from the application role as deployment hardening, and the chain itself, which makes any out-of-band tampering detectable by recomputation. A single writer serialized by a Postgres advisory lock is the only insert path, and every state mutation commits in the same transaction as its audit event.
