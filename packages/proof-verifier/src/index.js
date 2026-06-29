/**
 * @makerchecker/proof-verifier — public API.
 *
 * A standalone, dependency-free verifier for Agent Action Proof Receipt
 * bundles. Import the isomorphic core and a crypto provider, or use the bundled
 * CLI (`agent-proof verify`).
 */

export { verifyBundle, GENESIS_PREFIX } from "./verify-core.js";
export { canonicalJson, CanonicalizationError } from "./canonical-json.js";
export { nodeCrypto } from "./node-crypto.js";
