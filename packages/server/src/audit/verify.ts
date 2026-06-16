import { hashAuditEvent } from "@makerchecker/shared";
import type { Pool } from "pg";

import { genesisPrevHash, type AuditEventRow } from "./writer.js";

export type VerifyResult =
  | { ok: true; count: number; headHash: string | null }
  | { ok: false; count: number; failedSeq: string; reason: string };

const BATCH = 1000;

/** Recomputes the hash of a stored audit row; used by verify and bundle checks. */
export function recomputeHash(row: AuditEventRow): string {
  return hashAuditEvent({
    id: row.id,
    occurredAt: row.occurred_at,
    actor: row.actor,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    runId: row.run_id,
    payload: row.payload,
    prevHash: row.prev_hash,
  });
}

/**
 * Walks the entire chain in seq order, recomputing every hash and checking
 * prev_hash linkage back to the instance-derived genesis. Batched so chains of
 * millions of events verify in constant memory.
 */
export async function verifyChain(pool: Pool): Promise<VerifyResult> {
  const instance = await pool.query<{ id: string }>("SELECT id FROM instance LIMIT 1");
  const instanceId = instance.rows[0]?.id;
  if (!instanceId) throw new Error("instance row missing; run migrations first");

  let expectedPrevHash = genesisPrevHash(instanceId);
  let count = 0;
  let headHash: string | null = null;
  let afterSeq = "0";

  for (;;) {
    const { rows } = await pool.query<AuditEventRow>(
      `SELECT seq, id, occurred_at, actor, event_type, entity_type, entity_id, run_id,
              payload, prev_hash, hash
         FROM audit_events WHERE seq > $1 ORDER BY seq ASC LIMIT $2`,
      [afterSeq, BATCH],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      if (count === 0 && row.event_type !== "audit.genesis") {
        return { ok: false, count, failedSeq: row.seq, reason: "first event is not audit.genesis" };
      }
      if (row.prev_hash !== expectedPrevHash) {
        return {
          ok: false,
          count,
          failedSeq: row.seq,
          reason: `broken linkage: prev_hash ${row.prev_hash} != expected ${expectedPrevHash}`,
        };
      }
      const recomputed = recomputeHash(row);
      if (recomputed !== row.hash) {
        return {
          ok: false,
          count,
          failedSeq: row.seq,
          reason: `hash mismatch: stored ${row.hash}, recomputed ${recomputed} (row tampered)`,
        };
      }
      expectedPrevHash = row.hash;
      headHash = row.hash;
      count += 1;
      afterSeq = row.seq;
    }
  }

  return { ok: true, count, headHash };
}
