/** Strict segregation-of-duties mode: when on, no gate is self-approvable. Resolved per call. */
export function strictSod(): boolean {
  return process.env.MAKERCHECKER_REQUIRE_IDENTITY_GATES === "1";
}

/** Log level from MAKERCHECKER_LOG_LEVEL; unset/empty falls back to 'info'. */
export function logLevel(): string {
  const raw = process.env.MAKERCHECKER_LOG_LEVEL;
  if (raw === undefined || raw === "") return "info";
  return raw;
}
