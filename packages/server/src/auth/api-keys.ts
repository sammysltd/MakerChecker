import { createHash, randomBytes } from "node:crypto";

import type { Pool } from "pg";

import { recordEvent } from "../audit/writer.js";

/**
 * API-key authentication. Keys look like `mk_<32 hex>`; only the sha256 of
 * the plaintext is stored (key_hash) plus the first 8 characters (key_prefix)
 * for identification. The plaintext is returned exactly once at creation.
 */

const KEY_FORMAT = /^mk_[0-9a-f]{32}$/;
const KEY_PREFIX_LENGTH = 8;

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
}

export interface GeneratedApiKey {
  id: string;
  /** Shown once; never stored or logged by the server. */
  plaintext: string;
  keyPrefix: string;
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Creates an API key for a user; the plaintext is returned once, audited by prefix only. */
export async function generateApiKey(
  pool: Pool,
  input: { userId: string; name: string },
): Promise<GeneratedApiKey> {
  const plaintext = `mk_${randomBytes(16).toString("hex")}`;
  const keyPrefix = plaintext.slice(0, KEY_PREFIX_LENGTH);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO api_keys (user_id, key_prefix, key_hash, name)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.userId, keyPrefix, hashApiKey(plaintext), input.name],
    );
    const id = rows[0]!.id;
    await recordEvent(client, {
      eventType: "api_key.created",
      actor: { type: "user", id: input.userId },
      entityType: "api_key",
      entityId: id,
      payload: { keyPrefix, name: input.name },
    });
    await client.query("COMMIT");
    return { id, plaintext, keyPrefix };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Resolves a plaintext key to its (unrevoked) owner, or null. */
export async function authenticateApiKey(pool: Pool, plaintext: string): Promise<AuthUser | null> {
  if (!KEY_FORMAT.test(plaintext)) return null;
  const { rows } = await pool.query<AuthUser>(
    `SELECT u.id, u.email, u.display_name, u.is_admin
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashApiKey(plaintext)],
  );
  return rows[0] ?? null;
}
