#!/usr/bin/env node
// Governance middleware demo: an "external agent" (plain functions standing in
// for LangGraph/CrewAI/Claude Agent SDK tools) executes its own tools while
// MakerChecker authorizes each call and keeps the evidentiary record.
// Shows: one allowed call, one deny-by-default denial, one SoD denial after a
// conflicting role acted in the session, then the session's audit trail.
// Usage: node examples/middleware/governed-tool-demo.mjs
// (server on :3000 with the seeded demo; build the SDK first. Set
// MAKERCHECKER_API_KEY or run the server with MAKERCHECKER_AUTH_DISABLED=1.)
import { createClient, governedTool, GovernanceDeniedError } from "../../packages/sdk/dist/index.js";

const client = createClient({
  baseUrl: process.env.MAKERCHECKER_URL ?? "http://localhost:3000",
  ...(process.env.MAKERCHECKER_API_KEY ? { apiKey: process.env.MAKERCHECKER_API_KEY } : {}),
});

const { session } = await client.proxy.openSession({
  label: "external-framework-demo",
  externalRef: "demo-thread-1",
});
console.log(`proxy session ${session.id} opened`);

// The framework's own tool implementations — MakerChecker never executes these.
const ingest = governedTool(client, session.id, "recon-preparer", "csv-ingest@1", async (input) => {
  return { rows: 12, source: input.source };
});
const report = governedTool(client, session.id, "recon-preparer", "report-gen@1", async () => {
  throw new Error("unreachable: the check denies this before the tool runs");
});
const approve = governedTool(
  client,
  session.id,
  "recon-approver-bot",
  "approve-recon@1",
  async () => ({ approved: true }),
);

// 1. Allowed: recon-preparer's role holds an unrevoked grant for csv-ingest@1.
const out = await ingest({ source: "bank_statement.csv" });
console.log("csv-ingest@1 allowed; tool output recorded:", JSON.stringify(out));

// 2. Deny by default: report-gen@1 is granted to the reporter role, not the preparer's.
try {
  await report({});
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`report-gen@1 denied (${err.code}): ${err.reason}`);
}

// 3. SoD: the preparer role already acted in this session, and the seeded
// maker-checker constraint conflicts it with the approver role.
try {
  await approve({});
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`approve-recon@1 denied (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);

const detail = await client.proxy.getSession(session.id);
console.log("\naudit trail for the session:");
for (const event of detail.auditEvents) {
  const extra = event.payload.skillRef ? ` ${event.payload.agentName} -> ${event.payload.skillRef}` : "";
  console.log(`  ${event.seq}  ${event.event_type}${extra}`);
}
const verdict = await client.audit.verify();
console.log(`audit chain: ok=${verdict.ok} events=${verdict.count}`);
