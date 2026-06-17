import type { Logger } from "pino";
import type { Pool } from "pg";

import { recordEvent } from "../audit/writer.js";

/** Audit event type recording that the server booted on a tamper-capable DB credential. */
export const OWNER_DB_CREDENTIAL_EVENT = "instance.owner_db_credential";

/** Log/event message for a boot on a credential that can modify the audit chain. */
export const OWNER_DB_CREDENTIAL_MESSAGE =
  "the database credential can modify or delete audit_events (it owns the table, " +
  "can disable its append-only triggers, or holds UPDATE/DELETE/TRUNCATE/superuser). " +
  "The audit chain's table-level tamper-evidence then holds only against an external " +
  "attacker, not this credential. Run ops/harden-db.sql and connect as the non-owner " +
  "mc_app_runtime role (see docs/security-model.md).";

/**
 * Boolean probe: TRUE when the connected role can rewrite the audit chain —
 * it holds UPDATE/DELETE/TRUNCATE on audit_events, OR owns the table (a table
 * owner can ALTER TABLE ... DISABLE TRIGGER and neuter the append-only guards),
 * OR is a superuser. FALSE for the hardened non-owner mc_app_runtime role.
 */
const CAN_TAMPER_SQL = `
SELECT
  has_table_privilege(current_user, 'public.audit_events', 'UPDATE')
  OR has_table_privilege(current_user, 'public.audit_events', 'DELETE')
  OR has_table_privilege(current_user, 'public.audit_events', 'TRUNCATE')
  OR pg_has_role(
       current_user,
       (SELECT tableowner FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'audit_events'),
       'MEMBER')
  OR EXISTS (
       SELECT 1 FROM pg_roles
       WHERE rolname = current_user AND rolsuper)
  AS can_tamper_audit_chain`;

/**
 * True when boot should probe whether the DB credential can tamper with the
 * audit chain: not the compose demo (MAKERCHECKER_SEED_DEMO !== '1') and not a
 * test/CI run (NODE_ENV !== 'test').
 */
export function shouldCheckOwnerDb(env: NodeJS.ProcessEnv): boolean {
  return env.MAKERCHECKER_SEED_DEMO !== "1" && env.NODE_ENV !== "test";
}

/**
 * One-time boot warning when the server connects with a credential that can
 * modify or delete the audit chain: a prominent WARN plus a single audit event
 * so the gap is on the record. A failed probe or audit write is logged and
 * swallowed — it must never crash boot.
 */
export async function emitOwnerDbWarning(pool: Pool, logger: Logger): Promise<void> {
  if (!shouldCheckOwnerDb(process.env)) return;

  let canTamper: boolean;
  try {
    const { rows } = await pool.query<{ can_tamper_audit_chain: boolean }>(CAN_TAMPER_SQL);
    canTamper = rows[0]?.can_tamper_audit_chain === true;
  } catch (err) {
    logger.error(
      { err: { message: (err as Error).message } },
      "failed to probe audit-chain tamper capability of the database credential",
    );
    return;
  }
  if (!canTamper) return;

  logger.warn({ event: OWNER_DB_CREDENTIAL_EVENT }, OWNER_DB_CREDENTIAL_MESSAGE);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await recordEvent(client, {
      eventType: OWNER_DB_CREDENTIAL_EVENT,
      actor: { type: "system", id: "boot" },
      payload: { message: OWNER_DB_CREDENTIAL_MESSAGE },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(
      { err: { message: (err as Error).message } },
      "failed to record owner-db-credential audit event",
    );
  } finally {
    client.release();
  }
}
