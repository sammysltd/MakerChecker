/** Strict segregation-of-duties mode: when on, no gate is self-approvable. Resolved per call. */
export function strictSod(): boolean {
  return process.env.MAKERCHECKER_REQUIRE_IDENTITY_GATES === "1";
}
