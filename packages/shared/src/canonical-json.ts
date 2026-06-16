/**
 * RFC 8785 (JSON Canonicalization Scheme) serializer.
 *
 * Vendored rather than depended on: audit-chain hashes must be reproducible
 * byte-for-byte by external verifiers, so the exact canonicalization rules are
 * part of MakerChecker's public audit spec and must not drift with a dependency.
 *
 * Rules: no insignificant whitespace; object keys sorted by UTF-16 code units;
 * numbers serialized per ECMAScript Number::toString (which JSON.stringify
 * already implements); non-finite numbers are invalid.
 */

export class CanonicalizationError extends Error {
  override name = "CanonicalizationError";
}

export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number at ${path}`);
      }
      // JSON.stringify implements the ES number-to-string algorithm RFC 8785 requires.
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

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new CanonicalizationError(
      `non-plain object at ${path}; canonicalize only JSON-shaped data`,
    );
  }

  const record = value as Record<string, unknown>;
  // Default Array.prototype.sort compares UTF-16 code units, as RFC 8785 requires.
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const members = keys.map(
    (k) => `${JSON.stringify(k)}:${serialize(record[k], `${path}.${k}`)}`,
  );
  return `{${members.join(",")}}`;
}
