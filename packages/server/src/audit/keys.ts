import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { Pool } from "pg";

const KEY_FILE = "instance_key.pem";

export interface InstanceKeys {
  privateKey: KeyObject;
  publicKeyPem: string;
}

/**
 * Loads (or on first use generates) the instance's Ed25519 keypair. The
 * private key lives only on disk inside the deployment perimeter; the public
 * key is stored in the instance table and shipped inside export bundles so
 * they verify offline.
 */
export async function ensureInstanceKeys(pool: Pool, dataDir: string): Promise<InstanceKeys> {
  // dataDir is the operator-configured deployment data directory (not request
  // input) and KEY_FILE is a constant; these reads/writes target a fixed file
  // inside the deployment perimeter, not an attacker-controlled path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dataDir is operator-configured deployment config, not request input.
  mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, KEY_FILE);

  let privateKey: KeyObject;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- keyPath is join(dataDir, constant); dataDir is operator-configured deployment config.
  if (existsSync(keyPath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- keyPath is join(dataDir, constant); dataDir is operator-configured deployment config.
    privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
  } else {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- keyPath is join(dataDir, constant); dataDir is operator-configured deployment config.
    writeFileSync(
      keyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      { mode: 0o600 },
    );
  }

  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" }) as string;

  // Publish the public key only when it is actually missing or different. Issuing
  // the UPDATE unconditionally would require UPDATE privilege on `instance` on
  // every call (Postgres checks table privilege even for a zero-row match),
  // breaking a hardened SELECT-only runtime role on routine `audit export`. When
  // the key already matches (the steady state), no write is attempted. A genuine
  // mismatch (a swapped on-disk key while a chain exists) still attempts the
  // UPDATE and is then rejected by the write-once instance trigger — fail loud.
  const current = await pool.query<{ public_key_pem: string | null }>(
    "SELECT public_key_pem FROM instance LIMIT 1",
  );
  if (current.rows[0]?.public_key_pem !== publicKeyPem) {
    await pool.query(
      "UPDATE instance SET public_key_pem = $1 WHERE public_key_pem IS NULL OR public_key_pem <> $1",
      [publicKeyPem],
    );
  }

  return { privateKey, publicKeyPem };
}

export function signPayload(privateKey: KeyObject, data: string): string {
  return cryptoSign(null, Buffer.from(data, "utf8"), privateKey).toString("base64");
}

export function verifySignature(publicKeyPem: string, data: string, signatureB64: string): boolean {
  return cryptoVerify(
    null,
    Buffer.from(data, "utf8"),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureB64, "base64"),
  );
}
