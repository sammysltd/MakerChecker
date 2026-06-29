/**
 * Node.js crypto provider for the isomorphic verifier core. Uses only the
 * `node:crypto` standard library — no third-party dependencies.
 */

import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";

export const nodeCrypto = {
  sha256Hex(utf8String) {
    return createHash("sha256").update(utf8String, "utf8").digest("hex");
  },

  ed25519Verify(publicKeyPem, message, signatureBase64) {
    try {
      const key = createPublicKey(publicKeyPem);
      // Ed25519 uses a null algorithm in Node's one-shot verify.
      return nodeVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureBase64, "base64"));
    } catch {
      return false;
    }
  },

  samePublicKeyPem(a, b) {
    try {
      const da = createPublicKey(a).export({ type: "spki", format: "der" });
      const db = createPublicKey(b).export({ type: "spki", format: "der" });
      return da.equals(db);
    } catch {
      return false;
    }
  },

  keyFingerprint(publicKeyPem) {
    try {
      const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
      return createHash("sha256").update(der).digest("hex");
    } catch {
      return null;
    }
  },
};
