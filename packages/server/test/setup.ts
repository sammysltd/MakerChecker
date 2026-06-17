/** Per-worker test setup: silence the logger so the suite stays quiet. */
if (process.env.MAKERCHECKER_LOG_LEVEL === undefined) {
  process.env.MAKERCHECKER_LOG_LEVEL = "silent";
}
