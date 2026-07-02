/**
 * Zero-trust, dependency-free verification of an Agent Action Proof Receipt
 * bundle ({ manifest, events }), implemented from the public spec alone with no
 * access to the producer's database or code.
 *
 * Isomorphic core: all cryptography is injected through a `crypto` provider so
 * the same logic runs under Node (node:crypto) and in the browser (WebCrypto).
 * The provider supplies:
 *   - sha256Hex(utf8String)         -> hex string            (may be async)
 *   - ed25519Verify(pem, msg, sigB64) -> boolean             (may be async)
 *   - samePublicKeyPem(pemA, pemB)  -> boolean               (may be async)
 *   - keyFingerprint(pem)           -> hex string | null     (optional, may be async)
 *
 * Mirrors the reference implementation in
 * `packages/server/src/audit/export.ts` (verifyBundle) and the audit spec
 * (`docs/audit-spec.md`, schema version 1).
 */

import { canonicalJson, IllFormedStringError } from "./canonical-json.js";

/**
 * Genesis derivation prefix, fixed by the audit spec (schema version 1):
 *   genesisPrevHash = SHA-256("makerchecker-genesis:" + instanceId)
 * A full bundle's first event must chain to this root.
 */
export const GENESIS_PREFIX = "makerchecker-genesis:";

/** The canonical signing string: exactly these manifest fields, RFC 8785. */
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

/** Maps a stored snake_case event row to the camelCase object that is hashed. */
function hashInput(event) {
  return {
    id: event.id,
    occurredAt: event.occurred_at,
    actor: event.actor,
    eventType: event.event_type,
    entityType: event.entity_type,
    entityId: event.entity_id,
    runId: event.run_id,
    payload: event.payload,
    prevHash: event.prev_hash,
  };
}

function fail(reason, extra) {
  return { ok: false, reason, ...extra };
}

/**
 * Verifies a bundle. Returns
 *   { ok: true, count, bundleKind, headHash, keyFingerprint }
 * or
 *   { ok: false, reason, reasonCode?, failedSeq?, path? }.
 *
 * `reasonCode` is set for machine-distinguishable verdict classes; today the
 * only code is "ill_formed_string": the bundle violates the spec's I-JSON
 * (RFC 7493) requirement — an unpaired surrogate in a hashed string — so its
 * hash is not well-defined under RFC 8785. That is a SPEC-VIOLATION reject,
 * deliberately distinct from a tamper verdict: nothing is proven altered, but
 * the bundle can never cross-verify and must not be accepted.
 *
 * @param {object} bundle  parsed { manifest, events }
 * @param {object} crypto  injected crypto provider (see file header)
 * @param {object} [opts]  { expectedPublicKeyPem } for out-of-band key pinning
 */
export async function verifyBundle(bundle, crypto, opts = {}) {
  if (!bundle || typeof bundle !== "object" || !bundle.manifest || !Array.isArray(bundle.events)) {
    return fail("not a proof bundle: expected an object { manifest, events: [] }");
  }
  const { manifest, events } = bundle;

  // 0. Optional out-of-band key pinning. A bundle proves integrity and origin
  //    under the key embedded in it; it cannot prove which key is legitimate.
  //    Pinning rejects a bundle re-signed with an attacker's own key even though
  //    it is internally self-consistent.
  if (opts.expectedPublicKeyPem) {
    const same = await crypto.samePublicKeyPem(opts.expectedPublicKeyPem, manifest.publicKeyPem);
    if (!same) return fail("manifest public key does not match the pinned key");
  }

  // 1. Signature over the canonical signing string (excludes publicKeyPem, signature).
  let signingString;
  try {
    signingString = manifestSigningString(manifest);
  } catch (err) {
    if (err instanceof IllFormedStringError) {
      return fail(
        `manifest contains an ill-formed string (unpaired surrogate) at ${err.path}: ` +
          "the spec requires I-JSON (RFC 7493) input, so this bundle can never cross-verify",
        { reasonCode: "ill_formed_string", path: err.path },
      );
    }
    throw err;
  }
  const sigOk = await crypto.ed25519Verify(
    manifest.publicKeyPem,
    signingString,
    manifest.signature,
  );
  if (!sigOk) return fail("manifest signature invalid");

  // 2. Count.
  if (events.length !== manifest.count) {
    return fail(`event count ${events.length} != manifest count ${manifest.count}`);
  }

  // 3. Hash-set digest binds the exact event set and order into the signature.
  const digest = await crypto.sha256Hex(events.map((e) => e.hash).join("\n"));
  if (digest !== manifest.eventHashesDigest) {
    return fail("event hash set does not match the signed digest");
  }

  // 4. Run bundles: every event must belong to the signed runId. Each event's
  //    run_id is bound into its own hash (checked below), so a foreign event
  //    cannot be relabelled without failing its hash check. (This does not prove
  //    completeness against omission; only a full bundle's linkage does.)
  if (manifest.bundleKind === "run") {
    if (manifest.runId === null || manifest.runId === undefined) {
      return fail("run bundle manifest is missing runId");
    }
    const foreign = events.find((e) => e.run_id !== manifest.runId);
    if (foreign) {
      return fail(`event seq ${foreign.seq} does not belong to run ${manifest.runId}`, {
        failedSeq: foreign.seq,
      });
    }
  } else if (manifest.bundleKind !== "full") {
    return fail(`unknown bundleKind "${manifest.bundleKind}"`);
  }

  // 5. Per-event hashes, and (full bundles) genesis-rooted prev_hash linkage.
  let expectedPrevHash =
    manifest.bundleKind === "full"
      ? await crypto.sha256Hex(GENESIS_PREFIX + manifest.instanceId)
      : null;
  for (const event of events) {
    let recomputed;
    try {
      recomputed = await crypto.sha256Hex(canonicalJson(hashInput(event)));
    } catch (err) {
      if (err instanceof IllFormedStringError) {
        // Spec-violation verdict, distinct from tamper: the event carries a
        // string that is not I-JSON (RFC 7493), so RFC 8785 defines no bytes
        // to hash. The buggy pre-I-JSON JS producer emitted the ES2019 \uXXXX
        // escape here, which no other language's RFC 8785 implementation
        // reproduces — accepting it would "verify" JS-only semantics. Reject,
        // fail closed, with the seq and JSON path machine-readable.
        return fail(
          `event seq ${event.seq} contains an ill-formed string (unpaired surrogate) at ${err.path}: ` +
            "the spec requires I-JSON (RFC 7493) input, so this bundle can never cross-verify",
          { reasonCode: "ill_formed_string", failedSeq: event.seq, path: err.path },
        );
      }
      throw err;
    }
    if (recomputed !== event.hash) {
      return fail(`event seq ${event.seq} hash mismatch (row tampered)`, { failedSeq: event.seq });
    }
    if (expectedPrevHash !== null) {
      if (event.prev_hash !== expectedPrevHash) {
        return fail(`event seq ${event.seq} breaks chain linkage`, { failedSeq: event.seq });
      }
      expectedPrevHash = event.hash;
    }
  }

  // 6. Head and seq bounds complete the manifest/events match.
  const head = events.length ? events[events.length - 1].hash : null;
  if (head !== manifest.headHash) return fail("head hash does not match manifest");
  if ((events[0]?.seq ?? null) !== manifest.firstSeq) {
    return fail("first seq does not match manifest");
  }
  if ((events[events.length - 1]?.seq ?? null) !== manifest.lastSeq) {
    return fail("last seq does not match manifest");
  }

  const keyFingerprint = crypto.keyFingerprint
    ? await crypto.keyFingerprint(manifest.publicKeyPem)
    : undefined;
  return {
    ok: true,
    count: events.length,
    bundleKind: manifest.bundleKind,
    headHash: head,
    keyFingerprint,
  };
}
