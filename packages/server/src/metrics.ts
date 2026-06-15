import type { Pool } from "pg";

import { webhookFailureCount } from "./webhooks/dispatcher.js";

/**
 * Hand-rolled Prometheus text exposition (no client library — boring tech).
 * Served at /metrics (root, no auth) when MAKERCHECKER_METRICS=1; the
 * endpoint is for scrapers inside the deployment perimeter, so enabling it
 * is an explicit operator decision.
 */
export async function renderMetrics(pool: Pool): Promise<string> {
  const runs = await pool.query<{ status: string; n: string }>(
    "SELECT status, count(*) AS n FROM flow_runs GROUP BY status ORDER BY status",
  );
  const approvals = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM approvals WHERE status = 'pending'",
  );
  const audit = await pool.query<{ n: string }>("SELECT count(*) AS n FROM audit_events");
  // Proxy-session decisions: the most operationally important signal for a
  // deny-by-default control plane (a denial spike means misconfigured grants or
  // an agent attempting ungranted/SoD-violating actions). Emit BOTH series even
  // at zero so a scrape can alert on the jump from 0.
  const decisions = await pool.query<{ decision: string; n: string }>(
    "SELECT decision, count(*) AS n FROM proxy_actions GROUP BY decision",
  );
  const decisionCounts: Record<"allowed" | "denied", number> = { allowed: 0, denied: 0 };
  for (const r of decisions.rows) {
    if (r.decision === "allowed" || r.decision === "denied") {
      decisionCounts[r.decision] = Number(r.n);
    }
  }

  const lines = [
    "# HELP makerchecker_runs_total Flow runs by current status.",
    "# TYPE makerchecker_runs_total gauge",
    ...runs.rows.map((r) => `makerchecker_runs_total{status="${r.status}"} ${r.n}`),
    "# HELP makerchecker_approvals_pending Approvals currently awaiting a human decision.",
    "# TYPE makerchecker_approvals_pending gauge",
    `makerchecker_approvals_pending ${approvals.rows[0]!.n}`,
    "# HELP makerchecker_audit_events_total Events recorded in the hash-chained audit log.",
    "# TYPE makerchecker_audit_events_total counter",
    `makerchecker_audit_events_total ${audit.rows[0]!.n}`,
    "# HELP makerchecker_webhook_failures_total Webhook deliveries that exhausted every retry attempt since process start.",
    "# TYPE makerchecker_webhook_failures_total counter",
    `makerchecker_webhook_failures_total ${webhookFailureCount()}`,
    "# HELP makerchecker_proxy_decisions_total Proxy-session skill-call decisions by outcome.",
    "# TYPE makerchecker_proxy_decisions_total counter",
    `makerchecker_proxy_decisions_total{decision="allowed"} ${decisionCounts.allowed}`,
    `makerchecker_proxy_decisions_total{decision="denied"} ${decisionCounts.denied}`,
  ];
  return `${lines.join("\n")}\n`;
}
