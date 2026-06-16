import { createPublicKey } from "node:crypto";

import { canonicalJson, sha256Hex } from "@makerchecker/shared";
import type { Pool } from "pg";

import { signPayload, verifySignature, type InstanceKeys } from "./keys.js";
import { recomputeHash } from "./verify.js";
import { genesisPrevHash, type AuditEventRow } from "./writer.js";

/**
 * True if two PEM public keys are the same key, compared by canonical SPKI DER
 * bytes (so formatting/whitespace differences do not matter). Used for the
 * optional out-of-band key pinning in verifyBundle. Fails closed on a key that
 * cannot be parsed.
 */
function samePublicKey(a: string, b: string): boolean {
  try {
    const da = createPublicKey(a).export({ type: "spki", format: "der" });
    const db = createPublicKey(b).export({ type: "spki", format: "der" });
    return da.equals(db);
  } catch {
    return false;
  }
}

export interface BundleManifest {
  bundleKind: "full" | "run";
  schemaVersion: number;
  instanceId: string;
  exportedAt: string;
  runId: string | null;
  count: number;
  firstSeq: string | null;
  lastSeq: string | null;
  headHash: string | null;
  eventHashesDigest: string;
  publicKeyPem: string;
  signature: string;
}

export interface AuditBundle {
  manifest: BundleManifest;
  events: AuditEventRow[];
}

/** Exported for adversarial tests: forging bundles AS the key holder. */
export function manifestSigningString(m: Omit<BundleManifest, "signature">): string {
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

/**
 * Exports audit events as a signed, offline-verifiable bundle.
 * Full bundles carry the whole chain (linkage verifiable end-to-end);
 * run bundles carry one run's events (each event hash verifiable, set
 * integrity guaranteed by the signed digest of all event hashes).
 */
export async function exportBundle(
  pool: Pool,
  keys: InstanceKeys,
  options: { runId?: string; schemaVersion: number },
): Promise<AuditBundle> {
  const instance = await pool.query<{ id: string }>("SELECT id FROM instance LIMIT 1");
  const instanceId = instance.rows[0]?.id;
  if (!instanceId) throw new Error("instance row missing; run migrations first");

  const filter = options.runId ? "WHERE run_id = $1" : "";
  const params = options.runId ? [options.runId] : [];
  const { rows: events } = await pool.query<AuditEventRow>(
    `SELECT seq, id, occurred_at, actor, event_type, entity_type, entity_id, run_id,
            payload, prev_hash, hash
       FROM audit_events ${filter} ORDER BY seq ASC`,
    params,
  );

  const unsigned: Omit<BundleManifest, "signature"> = {
    bundleKind: options.runId ? "run" : "full",
    schemaVersion: options.schemaVersion,
    instanceId,
    exportedAt: new Date().toISOString(),
    runId: options.runId ?? null,
    count: events.length,
    firstSeq: events[0]?.seq ?? null,
    lastSeq: events[events.length - 1]?.seq ?? null,
    headHash: events[events.length - 1]?.hash ?? null,
    eventHashesDigest: sha256Hex(events.map((e) => e.hash).join("\n")),
    publicKeyPem: keys.publicKeyPem,
  };

  return {
    manifest: { ...unsigned, signature: signPayload(keys.privateKey, manifestSigningString(unsigned)) },
    events,
  };
}

export type BundleVerifyResult = { ok: true; count: number } | { ok: false; reason: string };

/**
 * Verifies a bundle with no database access: signature, per-event hashes,
 * the signed digest of the event-hash set, and (for full bundles) complete
 * genesis-rooted prev_hash linkage.
 */
export async function verifyBundle(
  bundle: AuditBundle,
  opts?: { expectedPublicKeyPem?: string },
): Promise<BundleVerifyResult> {
  const { manifest, events } = bundle;

  // Optional out-of-band key pinning. A bundle proves integrity and origin under
  // the key embedded in it; it cannot prove which key is legitimate. A relying
  // party that obtained the instance public key through a trusted channel (per
  // the audit spec / SECURITY.md) can pin it here, so a bundle re-signed with an
  // attacker's own key is rejected even though it is internally self-consistent.
  if (opts?.expectedPublicKeyPem && !samePublicKey(opts.expectedPublicKeyPem, manifest.publicKeyPem)) {
    return { ok: false, reason: "manifest public key does not match the pinned key" };
  }

  const { signature, ...unsigned } = manifest;
  if (!verifySignature(manifest.publicKeyPem, manifestSigningString(unsigned), signature)) {
    return { ok: false, reason: "manifest signature invalid" };
  }
  if (events.length !== manifest.count) {
    return { ok: false, reason: `event count ${events.length} != manifest count ${manifest.count}` };
  }
  if (sha256Hex(events.map((e) => e.hash).join("\n")) !== manifest.eventHashesDigest) {
    return { ok: false, reason: "event hash set does not match signed digest" };
  }

  // Run bundles: every event must belong to the signed runId. Each event's
  // run_id is bound into its own hash (recomputed below), so an attacker cannot
  // relabel a genuine foreign-run event to pass this check without failing the
  // per-event hash check. This does NOT prove completeness (a key holder can
  // still omit events); only a full bundle's genesis-rooted linkage does that.
  if (manifest.bundleKind === "run") {
    if (manifest.runId === null) {
      return { ok: false, reason: "run bundle manifest is missing runId" };
    }
    const foreign = events.find((e) => e.run_id !== manifest.runId);
    if (foreign) {
      return { ok: false, reason: `event seq ${foreign.seq} does not belong to run ${manifest.runId}` };
    }
  }

  let expectedPrevHash =
    manifest.bundleKind === "full" ? genesisPrevHash(manifest.instanceId) : null;
  for (const event of events) {
    if (recomputeHash(event) !== event.hash) {
      return { ok: false, reason: `event seq ${event.seq} hash mismatch (tampered)` };
    }
    if (expectedPrevHash !== null) {
      if (event.prev_hash !== expectedPrevHash) {
        return { ok: false, reason: `event seq ${event.seq} breaks chain linkage` };
      }
      expectedPrevHash = event.hash;
    }
  }
  const head = events[events.length - 1]?.hash ?? null;
  if (head !== manifest.headHash) {
    return { ok: false, reason: "head hash does not match manifest" };
  }
  // Cross-check the signed seq bounds against the actual events (headHash and
  // count are already checked; the seq bounds complete the manifest/events match).
  if ((events[0]?.seq ?? null) !== manifest.firstSeq) {
    return { ok: false, reason: "first seq does not match manifest" };
  }
  if ((events[events.length - 1]?.seq ?? null) !== manifest.lastSeq) {
    return { ok: false, reason: "last seq does not match manifest" };
  }
  return { ok: true, count: events.length };
}
