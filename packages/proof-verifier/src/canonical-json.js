/**
 * RFC 8785 (JSON Canonicalization Scheme) serializer.
 *
 * Vendored, dependency-free, and byte-for-byte identical to the producer's
 * serializer (MakerChecker's `packages/shared/src/canonical-json.ts`). These
 * exact rules are part of the public Agent Action Proof Receipt (AAPR) spec and
 * must not drift: an audit-chain hash is only reproducible by an external
 * verifier if canonicalization matches.
 *
 * Rules: no insignificant whitespace; object keys sorted by UTF-16 code units;
 * numbers serialized per the ECMAScript Number::toString algorithm (which
 * JSON.stringify implements); non-finite numbers are invalid; members whose
 * value is `undefined` are omitted; `null` serializes as `null`.
 *
 * Isomorphic: no Node or browser APIs are used here.
 */

export class CanonicalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export function canonicalJson(value) {
  return serialize(value, "$");
}

function serialize(value, path) {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalizationError(`unsupported type "${typeof value}" at ${path}`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item, i) =>
      serialize(item === undefined ? null : item, `${path}[${i}]`),
    );
    return `[${items.join(",")}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalizationError(
      `non-plain object at ${path}; canonicalize only JSON-shaped data`,
    );
  }

  // Default Array.prototype.sort compares UTF-16 code units, as RFC 8785 requires.
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  const members = keys.map(
    (k) => `${JSON.stringify(k)}:${serialize(value[k], `${path}.${k}`)}`,
  );
  return `{${members.join(",")}}`;
}
