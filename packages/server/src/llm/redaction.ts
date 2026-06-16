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

/**
 * Resolves the deployment's redaction hook from MAKERCHECKER_REDACTION:
 * 'example' -> exampleRegexRedactor, anything else (or unset) -> none.
 *
 * One hook, two seams: it runs over llm.call / skill.invoked audit payloads
 * BEFORE they are hashed into the chain (write path), and again over step
 * I/O and audit payloads on API reads and evidence-pack HTML (read path).
 * At-rest step_runs rows stay raw — encrypting the database is a deployment
 * concern, not the hook's job.
 */
export function resolveRedactionHook(): RedactionHook {
  return process.env.MAKERCHECKER_REDACTION === "example" ? exampleRegexRedactor : noRedaction;
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

/**
 * Example regex redactor proving the seam: masks email addresses and long
 * digit runs (account/card numbers) anywhere in the payload. Deployments
 * with real PII obligations should supply their own hook.
 */
export const exampleRegexRedactor: RedactionHook = (payload) => {
  const redactString = (s: string): string =>
    s.replace(EMAIL, "[REDACTED:email]").replace(LONG_DIGIT_RUN, "[REDACTED:number]");

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Json).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };

  return walk(payload) as Json;
};
