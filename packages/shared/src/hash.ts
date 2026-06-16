import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The hashed fields of an audit event. `seq` (storage order) is deliberately
 * absent: identity columns leave gaps on aborted transactions, so chain order
 * is defined solely by prev_hash linkage.
 */
export interface HashableAuditEvent {
  id: string;
  occurredAt: string;
  actor: Record<string, unknown>;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  prevHash: string;
}

/** Computes the chain hash for an audit event. Must match `audit verify` exactly. */
export function hashAuditEvent(event: HashableAuditEvent): string {
  return sha256Hex(canonicalJson(event as unknown as Record<string, unknown>));
}
