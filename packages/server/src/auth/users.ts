import { randomBytes } from "node:crypto";

import type { Pool } from "pg";

import { generateApiKey, type GeneratedApiKey } from "./api-keys.js";
import { hashPassword } from "./password.js";
import { recordEvent } from "../audit/writer.js";

// Operator-run identity bootstrap. Never wire these into boot — a default
// production image must auto-create no admin (deny by default).

const DUPLICATE_EMAIL = "23505";

export class UserExistsError extends Error {
  constructor(public readonly email: string) {
    super(`a user with email "${email}" already exists`);
    this.name = "UserExistsError";
  }
}

export interface CreatedUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export interface BootstrapAdminResult {
  user: CreatedUser;
  apiKey: GeneratedApiKey;
}

/** Creates a user, recording `user.created` in the same transaction. Throws {@link UserExistsError} on a duplicate email. */
export async function createUser(
  pool: Pool,
  input: { email: string; displayName: string; isAdmin?: boolean },
): Promise<CreatedUser> {
  const isAdmin = input.isAdmin ?? false;
  // No password-login flow; satisfy the NOT NULL column with an unusable hash.
  const passwordHash = await hashPassword(`mk-no-login-${randomBytes(16).toString("hex")}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, is_admin)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.email, passwordHash, input.displayName, isAdmin],
    );
    const id = rows[0]!.id;
    await recordEvent(client, {
      eventType: "user.created",
      actor: { type: "system", name: "cli" },
      entityType: "user",
      entityId: id,
      payload: { email: input.email, displayName: input.displayName, isAdmin },
    });
    await client.query("COMMIT");
    return { id, email: input.email, displayName: input.displayName, isAdmin };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isDuplicateEmail(err)) throw new UserExistsError(input.email);
    throw err;
  } finally {
    client.release();
  }
}

/** Creates an admin user and issues its API key, returned in plaintext exactly once. */
export async function bootstrapAdmin(
  pool: Pool,
  input: { email: string; displayName: string },
): Promise<BootstrapAdminResult> {
  const user = await createUser(pool, {
    email: input.email,
    displayName: input.displayName,
    isAdmin: true,
  });
  const apiKey = await generateApiKey(pool, { userId: user.id, name: "bootstrap-admin" });
  return { user, apiKey };
}

function isDuplicateEmail(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    String((err as { code?: unknown }).code) === DUPLICATE_EMAIL
  );
}
