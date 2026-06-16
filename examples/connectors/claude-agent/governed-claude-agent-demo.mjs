#!/usr/bin/env node
// Governed Claude Agent SDK demo: wrap, don't migrate.
//
// Wraps two Claude Agent SDK custom tools with governClaudeTool from
// @makerchecker/connector-claude-agent. The tools keep their name/description/
// inputSchema; MakerChecker becomes the deny-by-default checkpoint + audit. We
// invoke the governed handlers directly (no model call needed) to prove the
// governance integration: one ALLOWED call (recon-preparer holds txn-match@1)
// and one DENIED call (recon-preparer was never granted report-gen@1).
//
// Usage: node examples/connectors/claude-agent/governed-claude-agent-demo.mjs
//   - server on MAKERCHECKER_URL with the seeded demo + MAKERCHECKER_AUTH_DISABLED=1
import { z } from "zod";

import { createClient } from "../../../packages/sdk/dist/index.js";
import {
  governClaudeTool,
  GovernanceDeniedError,
} from "../../../packages/connector-claude-agent/dist/index.js";

const client = createClient({
  baseUrl: process.env.MAKERCHECKER_URL ?? "http://localhost:3000",
  ...(process.env.MAKERCHECKER_API_KEY ? { apiKey: process.env.MAKERCHECKER_API_KEY } : {}),
});

const { session } = await client.proxy.openSession({
  label: "governed-claude-agent-demo",
  externalRef: "claude-agent-thread-1",
});
console.log(`proxy session ${session.id} opened`);

const text = (t) => ({ content: [{ type: "text", text: t }] });

const matchTool = governClaudeTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "txn-match@1" },
  "match_txns",
  "Match statement transactions against the ledger.",
  { statement: z.array(z.string()) },
  async ({ statement }) => text(`matched ${statement.length} transactions`),
);

const reportTool = governClaudeTool(
  client,
  // recon-preparer's role was never granted report-gen@1 — deny by default.
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "report-gen@1" },
  "generate_report",
  "Render the reconciliation report.",
  { exceptions: z.number() },
  async () => text("report generated"),
);

console.log(`wrapped Claude SDK tools: ${matchTool.name}, ${reportTool.name}`);

// 1. ALLOWED — the check passes, the handler runs, the output is recorded.
const out = await matchTool.handler({ statement: ["t1", "t2", "t3"] }, {});
console.log(`match_txns ALLOWED; handler ran; output: ${JSON.stringify(out.content?.[0]?.text ?? out)}`);

// 2. DENIED — the check denies BEFORE the handler runs.
try {
  await reportTool.handler({ exceptions: 1 }, {});
  console.log("generate_report unexpectedly ran — governance did not deny!");
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`generate_report DENIED (${err.code}): ${err.reason} — handler never ran`);
}

await client.proxy.closeSession(session.id);
const verdict = await client.audit.verify();
console.log(`audit chain: ok=${verdict.ok} events=${verdict.count}`);
