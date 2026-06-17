import type { Logger } from "pino";
import type { Pool } from "pg";

import { recordEvent } from "../audit/writer.js";

/** Audit event type recording that a deployment booted with redaction off. */
export const REDACTION_DISABLED_EVENT = "instance.redaction_disabled";

/** Log/event message for a non-demo boot with audit redaction disabled. */
export const REDACTION_DISABLED_MESSAGE =
  "audit redaction is DISABLED: raw payloads (including PII) are hashed into the " +
  "immutable audit chain. Set MAKERCHECKER_REDACTION (example|standard) or supply a custom hook.";

/**
 * True when boot should warn that audit redaction is off: redaction unresolved
 * (MAKERCHECKER_REDACTION is neither 'example' nor 'standard'), not the compose
 * demo (MAKERCHECKER_SEED_DEMO !== '1'), and not a test/CI run (NODE_ENV !== 'test').
 */
export function shouldWarnRedactionOff(env: NodeJS.ProcessEnv): boolean {
  const redactionOff =
    env.MAKERCHECKER_REDACTION !== "example" && env.MAKERCHECKER_REDACTION !== "standard";
  return redactionOff && env.MAKERCHECKER_SEED_DEMO !== "1" && env.NODE_ENV !== "test";
}

/**
 * One-time boot warning when audit redaction is off on a non-demo deployment:
 * a prominent WARN plus a single audit event so the gap is on the record. A
 * failed audit write is logged and swallowed — it must never crash boot.
 */
export async function emitRedactionDisabledWarning(pool: Pool, logger: Logger): Promise<void> {
  if (!shouldWarnRedactionOff(process.env)) return;
  logger.warn({ event: REDACTION_DISABLED_EVENT }, REDACTION_DISABLED_MESSAGE);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await recordEvent(client, {
      eventType: REDACTION_DISABLED_EVENT,
      actor: { type: "system", id: "boot" },
      payload: { message: REDACTION_DISABLED_MESSAGE },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(
      { err: { message: (err as Error).message } },
      "failed to record redaction-disabled audit event",
    );
  } finally {
    client.release();
  }
}
