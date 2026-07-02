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
 *
 * Input MUST be I-JSON (RFC 7493): every string — key or value — must be
 * well-formed Unicode. RFC 8785 assumes I-JSON input and leaves an unpaired
 * surrogate undefined: ES2019 JSON.stringify emits the escape (`\ud800`)
 * while RFC 8785 implementations in other languages throw or emit different
 * bytes, so a hash over such a string can never cross-verify. We FAIL CLOSED —
 * an ill-formed string is rejected (IllFormedStringError) before any bytes are
 * hashed, identically here and in the standalone proof verifier.
 */

export class CanonicalizationError extends Error {
  override name = "CanonicalizationError";
}

/** An unpaired surrogate in a string (key or value): the input is not I-JSON. */
export class IllFormedStringError extends CanonicalizationError {
  override name = "IllFormedStringError";
  constructor(readonly path: string) {
    super(`ill-formed Unicode (unpaired surrogate) in string at ${path}`);
  }
}

// String.prototype.isWellFormed is ES2024 (Node >= 20, all modern browsers);
// captured loosely so the pinned ES2022 lib types need no augmentation.
const nativeIsWellFormed = (String.prototype as { isWellFormed?: () => boolean })
  .isWellFormed;

/**
 * True when `s` contains no unpaired surrogate (is well-formed UTF-16, hence
 * encodable as UTF-8). Uses String.prototype.isWellFormed where the runtime
 * provides it; the fallback is a dependency-free O(n) charCodeAt scan.
 */
export function isWellFormedString(s: string): boolean {
  if (nativeIsWellFormed) return nativeIsWellFormed.call(s);
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false; // low surrogate with no high before it
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return false; // high surrogate with no low after it
      i += 1; // skip the low half of a valid pair
    }
  }
  return true;
}

function assertWellFormed(s: string, path: string): void {
  if (!isWellFormedString(s)) throw new IllFormedStringError(path);
}

/**
 * Walks a parsed JSON value in the same order canonicalJson serializes it
 * (object keys sorted, undefined-valued members skipped, each key checked
 * before its value) and returns the path of the first ill-formed string, or
 * null when every string is well-formed Unicode. Lets an ingress boundary
 * reject non-I-JSON input with a clean 4xx — reporting the exact path
 * canonicalJson would otherwise throw for deep inside a transaction.
 */
export function findIllFormedString(value: unknown, path = "$"): string | null {
  if (typeof value === "string") return isWellFormedString(value) ? null : path;
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findIllFormedString(value[i], `${path}[${i}]`);
      if (found !== null) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  for (const k of keys) {
    const memberPath = `${path}.${k}`;
    if (!isWellFormedString(k)) return memberPath;
    const found = findIllFormedString(record[k], memberPath);
    if (found !== null) return found;
  }
  return null;
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
      // FAIL CLOSED before emitting bytes: an unpaired surrogate is not I-JSON
      // and has no interoperable RFC 8785 serialization (see file header).
      assertWellFormed(value, path);
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
  const members = keys.map((k) => {
    // Keys are strings too: check them before serializing, same as values.
    assertWellFormed(k, `${path}.${k}`);
    return `${JSON.stringify(k)}:${serialize(record[k], `${path}.${k}`)}`;
  });
  return `{${members.join(",")}}`;
}
