import { randomUUID } from "node:crypto";

import { hashAuditEvent, sha256Hex } from "@makerchecker/shared";
import type { PoolClient } from "pg";

export interface Actor {
  type: "user" | "agent" | "system";
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface RecordEventInput {
  eventType: string;
  actor: Actor;
  payload: Record<string, unknown>;
  entityType?: string;
  entityId?: string;
  runId?: string;
}

export interface AuditEventRow {
  seq: string;
  id: string;
  occurred_at: string;
  actor: Actor;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  run_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export function genesisPrevHash(instanceId: string): string {
  return sha256Hex(`makerchecker-genesis:${instanceId}`);
}

/**
 * The ONLY code path allowed to insert into audit_events.
 *
 * Must be called with a client inside an open transaction; the caller's state
 * mutations commit or abort atomically with their audit event — logging IS the
 * write path. A transaction-scoped advisory lock serializes chain appends, so
 * the read-head/compute/insert sequence is race-free across processes.
 */
export async function recordEvent(
  client: PoolClient,
  input: RecordEventInput,
): Promise<AuditEventRow> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('makerchecker_audit_chain'))");

  const head = await client.query<{ hash: string }>(
    "SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1",
  );

  let prevHash: string;
  if (head.rows[0]) {
    prevHash = head.rows[0].hash;
  } else {
    prevHash = await writeGenesis(client);
  }

  return insertEvent(client, input, prevHash);
}

/** Writes the genesis event for an empty chain; returns its hash. */
async function writeGenesis(client: PoolClient): Promise<string> {
  const instance = await client.query<{ id: string }>("SELECT id FROM instance LIMIT 1");
  const instanceId = instance.rows[0]?.id;
  if (!instanceId) {
    throw new Error("instance row missing; run migrations first");
  }
  const genesis = await insertEvent(
    client,
    {
      eventType: "audit.genesis",
      actor: { type: "system" },
      payload: { instanceId },
    },
    genesisPrevHash(instanceId),
  );
  return genesis.hash;
}

async function insertEvent(
  client: PoolClient,
  input: RecordEventInput,
  prevHash: string,
): Promise<AuditEventRow> {
  const id = randomUUID();
  const occurredAt = new Date().toISOString();
  const hash = hashAuditEvent({
    id,
    occurredAt,
    actor: input.actor,
    eventType: input.eventType,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    runId: input.runId ?? null,
    payload: input.payload,
    prevHash,
  });

  const { rows } = await client.query<AuditEventRow>(
    `INSERT INTO audit_events
       (id, occurred_at, actor, event_type, entity_type, entity_id, run_id, payload, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING seq, id, occurred_at, actor, event_type, entity_type, entity_id, run_id, payload, prev_hash, hash`,
    [
      id,
      occurredAt,
      JSON.stringify(input.actor),
      input.eventType,
      input.entityType ?? null,
      input.entityId ?? null,
      input.runId ?? null,
      JSON.stringify(input.payload),
      prevHash,
      hash,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("audit insert returned no row");
  return row;
}
