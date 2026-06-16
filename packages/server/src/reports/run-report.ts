import { sha256Hex } from "@makerchecker/shared";
import type { Pool } from "pg";

import { verifyChain } from "../audit/verify.js";
import { redactValue, resolveRedactionHook } from "../llm/redaction.js";
import { esc, fmtTime, hashPrefix, htmlDocument, summarizeJson } from "./html.js";

/**
 * The run evidence pack: one self-contained HTML file a reviewer or
 * regulator can read with nothing but a browser. Everything in it comes from
 * the database at render time; the chain-verification section recomputes the
 * full audit chain so the document carries its own integrity statement.
 *
 * The configured redaction hook (MAKERCHECKER_REDACTION) is applied to step
 * I/O exactly as on the read API — the report never exposes more than the
 * API does.
 */
export async function renderRunReportHtml(pool: Pool, runId: string): Promise<string> {
  const redact = resolveRedactionHook();

  const run = await pool.query<{
    id: string;
    flow: string;
    version: number;
    status: string;
    failure_reason: string | null;
    triggered_by: Record<string, unknown>;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
  }>(
    `SELECT fr.id, f.name AS flow, fv.version, fr.status, fr.failure_reason,
            fr.triggered_by, fr.created_at, fr.started_at, fr.finished_at
       FROM flow_runs fr
       JOIN flow_versions fv ON fv.id = fr.flow_version_id
       JOIN flows f ON f.id = fv.flow_id
      WHERE fr.id = $1`,
    [runId],
  );
  const header = run.rows[0];
  if (!header) throw new Error(`run ${runId} not found`);

  const steps = await pool.query<{
    step_index: number;
    step_key: string;
    status: string;
    attempt: number;
    agent: string | null;
    input: unknown;
    output: unknown;
    error: unknown;
    started_at: Date | null;
    finished_at: Date | null;
  }>(
    `SELECT sr.step_index, sr.step_key, sr.status, sr.attempt, a.name AS agent,
            sr.input, sr.output, sr.error, sr.started_at, sr.finished_at
       FROM step_runs sr LEFT JOIN agents a ON a.id = sr.agent_id
      WHERE sr.run_id = $1 ORDER BY sr.step_index, sr.attempt`,
    [runId],
  );

  const approvals = await pool.query<{
    id: string;
    step_key: string;
    status: string;
    required_approvals: number;
    requested_at: Date;
    decided_at: Date | null;
  }>(
    `SELECT id, step_key, status, required_approvals, requested_at, decided_at
       FROM approvals WHERE run_id = $1 ORDER BY requested_at`,
    [runId],
  );

  const decisions = await pool.query<{
    approval_id: string;
    decision: string;
    reason: string | null;
    created_at: Date;
    decided_by: string | null;
  }>(
    `SELECT ad.approval_id, ad.decision, ad.reason, ad.created_at,
            coalesce(u.email, ad.decided_by_label) AS decided_by
       FROM approval_decisions ad
       JOIN approvals ap ON ap.id = ad.approval_id
       LEFT JOIN users u ON u.id = ad.decided_by_user_id
      WHERE ap.run_id = $1 ORDER BY ad.created_at, ad.id`,
    [runId],
  );

  const events = await pool.query<{
    seq: string;
    occurred_at: string;
    actor: { type?: string; name?: string; id?: string };
    event_type: string;
    hash: string;
  }>(
    `SELECT seq, occurred_at, actor, event_type, hash
       FROM audit_events WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );

  const verification = await verifyChain(pool);
  const instance = await pool.query<{ public_key_pem: string | null }>(
    "SELECT public_key_pem FROM instance LIMIT 1",
  );
  const pem = instance.rows[0]?.public_key_pem ?? null;
  const fingerprint = pem ? sha256Hex(pem).slice(0, 16) : null;

  const trigger = header.triggered_by;
  const triggerLabel = [trigger.type, trigger.name ?? trigger.id]
    .filter((v) => v !== undefined && v !== null && v !== "")
    .join(" / ");

  const stepRows = steps.rows
    .map(
      (s) => `<tr>
  <td>${s.step_index}</td>
  <td>${esc(s.step_key)}</td>
  <td>${esc(s.agent ?? "—")}</td>
  <td class="status">${esc(s.status)}</td>
  <td>${s.attempt}</td>
  <td>${esc(fmtTime(s.started_at))}<br>${esc(fmtTime(s.finished_at))}</td>
  <td class="mono">in: ${esc(summarizeJson(redactValue(redact, s.input)))}<br>
      out: ${esc(summarizeJson(redactValue(redact, s.output)))}<br>
      err: ${esc(summarizeJson(redactValue(redact, s.error)))}</td>
</tr>`,
    )
    .join("\n");

  const approvalBlocks = approvals.rows
    .map((ap) => {
      const own = decisions.rows.filter((d) => d.approval_id === ap.id);
      const decisionRows =
        own.length === 0
          ? `<tr><td colspan="4" class="muted">no decisions recorded</td></tr>`
          : own
              .map(
                (d) => `<tr>
  <td class="status">${esc(d.decision)}</td>
  <td>${esc(d.decided_by ?? "—")}</td>
  <td>${esc(fmtTime(d.created_at))}</td>
  <td>${esc(d.reason ?? "—")}</td>
</tr>`,
              )
              .join("\n");
      return `<h3>Gate “${esc(ap.step_key)}” — <span class="status">${esc(ap.status)}</span>
  (${ap.required_approvals} approval(s) required; requested ${esc(fmtTime(ap.requested_at))}${
    ap.decided_at ? `, decided ${esc(fmtTime(ap.decided_at))}` : ""
  })</h3>
<table>
<tr><th>Decision</th><th>By</th><th>When</th><th>Reason (verbatim)</th></tr>
${decisionRows}
</table>`;
    })
    .join("\n");

  const eventRows = events.rows
    .map(
      (e) => `<tr>
  <td>${esc(e.seq)}</td>
  <td>${esc(e.event_type)}</td>
  <td>${esc([e.actor.type, e.actor.name ?? e.actor.id].filter(Boolean).join(" / "))}</td>
  <td>${esc(e.occurred_at)}</td>
  <td class="mono">${esc(hashPrefix(e.hash))}</td>
</tr>`,
    )
    .join("\n");

  const verificationHtml = verification.ok
    ? `<p class="ok">Chain verification: PASSED — ${verification.count} events recomputed,
genesis-rooted linkage intact.</p>
<table class="kv">
<tr><td>Head hash</td><td class="mono">${esc(verification.headHash ?? "—")}</td></tr>
<tr><td>Instance public key fingerprint</td>
    <td class="mono">${esc(fingerprint ?? "no instance key registered")}</td></tr>
</table>`
    : `<p class="bad">Chain verification: FAILED at seq ${esc(verification.failedSeq)} —
${esc(verification.reason)}. This document must not be relied on as evidence.</p>`;

  const body = `<h1>Run evidence pack</h1>
<p class="meta">MakerChecker · run <span class="mono">${esc(header.id)}</span> ·
generated ${esc(new Date().toISOString())}</p>

<h2>Run</h2>
<table class="kv">
<tr><td>Flow</td><td>${esc(header.flow)} (version ${header.version})</td></tr>
<tr><td>Status</td><td class="status">${esc(header.status)}${
    header.failure_reason
      ? ` — ${esc(String(redactValue(redact, header.failure_reason)))}`
      : ""
  }</td></tr>
<tr><td>Triggered by</td><td>${esc(triggerLabel || "unknown")}</td></tr>
<tr><td>Created</td><td>${esc(fmtTime(header.created_at))}</td></tr>
<tr><td>Started</td><td>${esc(fmtTime(header.started_at))}</td></tr>
<tr><td>Finished</td><td>${esc(fmtTime(header.finished_at))}</td></tr>
</table>

<h2>Step timeline</h2>
<table>
<tr><th>#</th><th>Step</th><th>Agent</th><th>Status</th><th>Attempt</th>
<th>Started / finished</th><th>I/O</th></tr>
${stepRows || `<tr><td colspan="7" class="muted">no step attempts recorded</td></tr>`}
</table>

<h2>Approvals</h2>
${approvalBlocks || `<p class="muted">No approval gates in this run.</p>`}

<h2>Audit events</h2>
<table>
<tr><th>Seq</th><th>Type</th><th>Actor</th><th>Time</th><th>Hash</th></tr>
${eventRows || `<tr><td colspan="5" class="muted">no audit events</td></tr>`}
</table>

<h2>Chain verification</h2>
${verificationHtml}`;

  return htmlDocument(`Run evidence pack — ${header.flow} — ${header.id}`, body);
}
