#!/usr/bin/env node
// Governed LangChain demo: wrap, don't migrate.
//
// A developer already has two real @langchain/core tools. Instead of porting
// them into another orchestrator to get governance, they wrap each one with
// governLangChainTool from @makerchecker/connector-langchain. The tools keep
// their name/description/schema and still run inside LangChain; MakerChecker
// becomes the deny-by-default checkpoint and the hash-chained audit record.
//
// Shows: one ALLOWED call (recon-preparer holds txn-match@1) and one DENIED
// call (recon-preparer was never granted report-gen@1), then prints the
// session's audit trail and verifies the chain.
//
// Usage: node examples/connectors/langchain/governed-langchain-demo.mjs
//   - server on :3000 with the seeded demo (docker compose up)
//   - build first: pnpm --filter @makerchecker/sdk --filter @makerchecker/connector-langchain build
//   - set MAKERCHECKER_API_KEY, or run the server with MAKERCHECKER_AUTH_DISABLED=1
//
// Requires @langchain/core on the path (installed in the connector package).
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { createClient } from "../../../packages/sdk/dist/index.js";
import {
  governLangChainTool,
  GovernanceDeniedError,
} from "../../../packages/connector-langchain/dist/index.js";

const client = createClient({
  baseUrl: process.env.MAKERCHECKER_URL ?? "http://localhost:3000",
  ...(process.env.MAKERCHECKER_API_KEY ? { apiKey: process.env.MAKERCHECKER_API_KEY } : {}),
});

// Two REAL LangChain tools — exactly what a developer already has. The bodies
// are stand-ins; in a real app these call your matcher and your report engine.
const matchTxns = tool(
  async ({ statement }) => ({ matched: statement.length, exceptions: 1 }),
  {
    name: "match_txns",
    description: "Match statement transactions against the ledger; flag exceptions.",
    schema: z.object({ statement: z.array(z.string()) }),
  },
);

const generateReport = tool(
  async ({ exceptions }) => ({ report: `report over ${exceptions} exceptions` }),
  {
    name: "generate_report",
    description: "Render the reconciliation summary report.",
    schema: z.object({ exceptions: z.number() }),
  },
);

const { session } = await client.proxy.openSession({
  label: "governed-langchain-demo",
  externalRef: "langchain-thread-1",
});
console.log(`proxy session ${session.id} opened`);

// Wrap each tool. The wrapper preserves name/description/schema, so these drop
// straight into a ToolNode / agent executor — the graph is unchanged.
const governedMatch = governLangChainTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "txn-match@1" },
  matchTxns,
);
const governedReport = governLangChainTool(
  client,
  // recon-preparer's role was never granted report-gen@1 — deny by default.
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "report-gen@1" },
  generateReport,
);

console.log(
  `\nwrapped tools (name/description/schema preserved): ` +
    `${governedMatch.name}, ${governedReport.name}`,
);

// 1. ALLOWED — the check passes, LangChain runs the tool, the output is recorded.
const out = await governedMatch.invoke({ statement: ["t1", "t2", "t3"] });
console.log(`\nmatch_txns ALLOWED; tool ran inside LangChain; recorded:`, JSON.stringify(out));

// 2. DENIED — the check denies BEFORE the tool runs; the tool body never executes.
try {
  await governedReport.invoke({ exceptions: 1 });
  console.log("generate_report unexpectedly ran — governance did not deny!");
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`generate_report DENIED (${err.code}): ${err.reason} — tool never ran`);
}

await client.proxy.closeSession(session.id);

const detail = await client.proxy.getSession(session.id);
console.log("\naudit trail for the session:");
for (const event of detail.auditEvents) {
  const ref = event.payload.skillRef ? ` ${event.payload.agentName} -> ${event.payload.skillRef}` : "";
  console.log(`  ${event.seq}  ${event.event_type}${ref}`);
}
const verdict = await client.audit.verify();
console.log(`\naudit chain: ok=${verdict.ok} events=${verdict.count}`);
