export type Json = Record<string, unknown>;

/**
 * Applied to every llm.call and skill.invoked audit payload BEFORE it is
 * hashed into the chain. The chain stores what the hook returns — redaction
 * is part of the write path, not a display-time filter.
 */
export type RedactionHook = (payload: Json) => Json;

export const noRedaction: RedactionHook = (payload) => payload;

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const LONG_DIGIT_RUN = /\b\d{8,19}\b/g; // account numbers, card numbers

// IBAN and card patterns are CANDIDATES only: a match is masked solely when it
// passes the IBAN mod-97 (ISO 7064) or card Luhn checksum, so prose, base64,
// SWIFT codes, API keys, and phone numbers that merely share the shape are left
// intact — over-masking is irreversible once a payload is hashed into the chain.
const IBAN_COMPACT = /\b[A-Z]{2}\d{2}[A-Za-z0-9]{11,30}\b/g;
// eslint-disable-next-line security/detect-unsafe-regex -- fixed 4-char blocks, single-space separators, bounded {2,7} repeat; backtracking is finite.
const IBAN_GROUPED = /\b[A-Z]{2}\d{2}(?: [A-Za-z0-9]{4}){2,7}(?: [A-Za-z0-9]{1,3})?\b/g;
const CARD_SEPARATED = /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/g;

/**
 * Resolves the deployment's redaction hook from MAKERCHECKER_REDACTION:
 * 'example' -> exampleRegexRedactor, 'standard' -> standardRedactor, anything
 * else (or unset) -> none.
 *
 * One hook, two seams: it runs over llm.call / skill.invoked audit payloads
 * BEFORE they are hashed into the chain (write path), and again over step
 * I/O and audit payloads on API reads and evidence-pack HTML (read path).
 * At-rest step_runs rows stay raw — encrypting the database is a deployment
 * concern, not the hook's job.
 */
export function resolveRedactionHook(): RedactionHook {
  switch (process.env.MAKERCHECKER_REDACTION) {
    case "example":
      return exampleRegexRedactor;
    case "standard":
      return standardRedactor;
    default:
      return noRedaction;
  }
}

/**
 * Applies a hook to a value that may not be an object (step output, error,
 * nullable columns) by wrapping it in a one-key payload. null/undefined pass
 * through untouched.
 */
export function redactValue(hook: RedactionHook, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  return hook({ v: value }).v;
}

/** Walks a payload recursively, applying redactString to every string. */
function walkPayload(payload: Json, redactString: (s: string) => string): Json {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(payload) as Json;
}

/**
 * Example regex redactor proving the seam: masks email addresses and long
 * digit runs (account/card numbers) anywhere in the payload. Deployments
 * with real PII obligations should supply their own hook.
 */
export const exampleRegexRedactor: RedactionHook = (payload) =>
  walkPayload(payload, (s) =>
    s.replace(EMAIL, "[REDACTED:email]").replace(LONG_DIGIT_RUN, "[REDACTED:number]"),
  );

/** ISO 7064 mod-97 IBAN checksum; only a passing candidate is a real IBAN. */
function isValidIban(raw: string): boolean {
  const s = raw.replace(/ /g, "").toUpperCase();
  if (s.length < 15 || s.length > 34 || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const n = ch.charCodeAt(0) - (ch >= "A" ? 55 : 48); // A..Z -> 10..35, 0..9 -> 0..9
    rem = (n > 9 ? rem * 100 + n : rem * 10 + n) % 97;
  }
  return rem === 1;
}

/** Luhn checksum; only a passing candidate is a real card number. */
function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt && (d *= 2) > 9) d -= 9;
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Stronger built-in: the example targets plus high-confidence financial PII.
 * IBAN and card candidates are masked ONLY when their checksum validates, so a
 * value that merely shares the shape survives. An anchored regex baseline, not a
 * compliance control — real PII obligations still warrant a custom hook.
 */
export const standardRedactor: RedactionHook = (payload) =>
  walkPayload(payload, (s) =>
    s
      .replace(IBAN_GROUPED, (m) => (isValidIban(m) ? "[REDACTED:iban]" : m))
      .replace(IBAN_COMPACT, (m) => (isValidIban(m) ? "[REDACTED:iban]" : m))
      .replace(CARD_SEPARATED, (m) => (luhnOk(m.replace(/[ -]/g, "")) ? "[REDACTED:card]" : m))
      .replace(EMAIL, "[REDACTED:email]")
      .replace(LONG_DIGIT_RUN, "[REDACTED:number]"),
  );
