#!/usr/bin/env node
// Drives the Daily Cash Reconciliation demo end to end through the SDK:
// trigger -> poll -> approve -> print report + audit verification.
// Usage: node examples/sdk-demo.mjs   (server on :3000; build the SDK first)
// Set MAKERCHECKER_API_KEY to the key printed at seed time (or run the
// server with MAKERCHECKER_AUTH_DISABLED=1).
import { fileURLToPath } from "node:url";

import { createClient } from "../packages/sdk/dist/index.js";

const client = createClient({
  baseUrl: process.env.MAKERCHECKER_URL ?? "http://localhost:3000",
  ...(process.env.MAKERCHECKER_API_KEY ? { apiKey: process.env.MAKERCHECKER_API_KEY } : {}),
});

const dir = new URL("./daily-cash-reconciliation/", import.meta.url);
const { runId } = await client.flows.trigger("daily-cash-reconciliation", {
  statementPath: fileURLToPath(new URL("bank_statement.csv", dir)),
  ledgerPath: fileURLToPath(new URL("ledger.csv", dir)),
});
console.log(`run ${runId} started`);

async function waitFor(...statuses) {
  for (let i = 0; i < 240; i += 1) {
    const { run } = await client.runs.get(runId);
    if (statuses.includes(run.status)) return run.status;
    if (["failed", "cancelled", "timed_out"].includes(run.status)) {
      throw new Error(`run ${run.status}: ${run.failure_reason}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${statuses}`);
}

await waitFor("waiting_approval");
const { approvals } = await client.approvals.list();
const gate = approvals.find((a) => a.run_id === runId);
console.log(`approval gate "${gate.step_key}" pending — approving`);
await client.approvals.decide(gate.id, "approved", "exceptions reviewed via SDK demo");

const finalStatus = await waitFor("completed", "failed");
const detail = await client.runs.get(runId);
const report = detail.steps.find((s) => s.step_key === "report" && s.status === "completed");
console.log(`run ${finalStatus}; report output:`, JSON.stringify(report?.output, null, 2));

const verdict = await client.audit.verify();
console.log(`audit chain: ok=${verdict.ok} events=${verdict.count}`);
