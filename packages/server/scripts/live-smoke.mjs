/**
 * Live LLM smoke test: a REAL model drives a governed step end to end —
 * local skill + MCP skill — with every call audited.
 *
 * Usage:
 *   DATABASE_URL=postgres://... GEMINI_API_KEY=... node scripts/live-smoke.mjs
 *   (or ANTHROPIC_API_KEY=... LIVE_PROVIDER=anthropic)
 *
 * Prints the step output and the audit trail summary. Never prints secrets.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "../dist/db/migrate.js";
import { createPool } from "../dist/db/pool.js";
import { LLMExecutor } from "../dist/engine/llm-executor.js";
import { AnthropicProvider } from "../dist/llm/anthropic.js";
import { OpenAICompatibleProvider } from "../dist/llm/openai-compatible.js";
import { SkillInvoker } from "../dist/skills/invoker.js";
import { verifyChain } from "../dist/audit/verify.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures");

const providerName = process.env.LIVE_PROVIDER ?? "gemini";
const providers = {};
let modelConfig;

if (providerName === "anthropic") {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  providers.anthropic = new AnthropicProvider({});
  modelConfig = { provider: "anthropic", model: "claude-opus-4-8" };
} else {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  providers.gemini = new OpenAICompatibleProvider({
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.GEMINI_API_KEY,
  });
  modelConfig = {
    provider: "gemini",
    model: process.env.LIVE_MODEL ?? "gemini-3-flash-preview",
  };
}

const pool = createPool();
await migrate(pool);

await pool.query(
  `INSERT INTO skills (name, version, description, input_schema, output_schema, implementation, risk_tier)
   VALUES
   ('get-balance', 1, 'Look up the current balance for an account id.',
    '{"type":"object","properties":{"accountId":{"type":"string"}},"required":["accountId"]}',
    '{}', '{"type":"local"}', 'low'),
   ('notify', 1, 'Send a notification message to a channel.',
    '{"type":"object","properties":{"channel":{"type":"string"},"message":{"type":"string"}},"required":["channel","message"]}',
    '{}', $1, 'low')
   ON CONFLICT DO NOTHING`,
  [
    JSON.stringify({
      type: "mcp",
      transport: "stdio",
      command: process.execPath,
      args: [join(FIXTURES, "mcp-echo-server.mjs")],
      tool: "notify",
    }),
  ],
);

const localRegistry = new Map([
  ["get-balance@1", async (input) => ({ accountId: input.accountId, balance: 18250.42, currency: "USD" })],
]);

const invoker = new SkillInvoker(pool, localRegistry);
const executor = new LLMExecutor({ pool, providers, invoker });

const runId = crypto.randomUUID();
console.log(`provider=${providerName} model=${modelConfig.model}`);
console.log("executing governed step with a live model...");

const output = await executor.execute({
  step: {
    key: "balance_check",
    agent: "smoke-agent",
    skills: ["get-balance@1", "notify@1"],
    instructions:
      "Look up the balance for account ACC-7 using the get-balance tool, " +
      "then send a notification to channel #recon stating the balance using the notify tool. " +
      "Finally, summarize what you did in one sentence.",
  },
  input: {},
  signal: new AbortController().signal,
  meta: {
    runId,
    stepRunId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    agentName: "smoke-agent",
    modelConfig,
  },
});

console.log("\n=== step output ===");
console.log(JSON.stringify(output, null, 2));

const { rows } = await pool.query(
  "SELECT event_type, payload->>'skillRef' AS skill, payload->'usage' AS usage FROM audit_events WHERE run_id = $1 ORDER BY seq",
  [runId],
);
console.log("\n=== audit trail for this run ===");
for (const row of rows) {
  console.log(`${row.event_type}${row.skill ? ` ${row.skill}` : ""}${row.usage ? ` tokens=${JSON.stringify(row.usage)}` : ""}`);
}

const chain = await verifyChain(pool);
console.log(`\naudit chain verify: ok=${chain.ok} count=${chain.count}`);

await invoker.close();
await pool.end();
if (!chain.ok || rows.length < 3) {
  console.error("SMOKE FAILED");
  process.exit(1);
}
console.log("LIVE SMOKE OK");
