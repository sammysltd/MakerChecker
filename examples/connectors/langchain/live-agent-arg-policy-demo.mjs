#!/usr/bin/env node
// Live-agent capstone for the argument-level grant policy.
//
// A REAL Gemini-backed LangChain agent is given one governed tool, `transfer`,
// and asked to move tokens. The wallet-agent role carries an argument policy on
// transfer@1: a destination allowlist {field:"destination", values:["0xSAFE"]}.
// The agent decides the arguments; MakerChecker checks them. An off-allowlist
// destination is BLOCKED before the tool runs; an on-allowlist one is ALLOWED.
// This proves the control governs a live LLM agent's chosen arguments, not just
// which tool it may call.
//
// Requires: server on MAKERCHECKER_URL with the wallet-agent role seeded
// (see scripts/e2e-examples.sh), GEMINI_API_KEY in the env, and
// @langchain/google-genai installed in this package.
import { tool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
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

// Pick the live model by provider, so the SAME governed agent runs on Gemini,
// Claude, or GPT. Each provider client reads its own key from the environment.
const provider = process.env.LIVE_AGENT_PROVIDER ?? "gemini";
async function makeModel() {
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY required");
    const { ChatAnthropic } = await import("@langchain/anthropic");
    return new ChatAnthropic({
      model: process.env.LIVE_AGENT_MODEL ?? "claude-3-5-haiku-latest",
      temperature: 0,
    });
  }
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");
    const { ChatOpenAI } = await import("@langchain/openai");
    // No temperature: the gpt-5 family rejects non-default temperature.
    return new ChatOpenAI({ model: process.env.LIVE_AGENT_MODEL ?? "gpt-5-nano" });
  }
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY required");
  const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
  return new ChatGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.LIVE_AGENT_MODEL ?? "gemini-2.5-flash",
    temperature: 0,
  });
}
const model = await makeModel();
console.log(`live model provider: ${provider}`);

// The developer's real tool. The body is a stand-in for a payments call;
// MakerChecker never runs it unless the check passes.
const transfer = tool(
  async ({ destination, amount }) => ({ status: "sent", destination, amount, txHash: "0xDEMO" }),
  {
    name: "transfer",
    description: "Transfer tokens to a destination wallet address.",
    schema: z.object({
      destination: z.string().describe("the recipient wallet address"),
      amount: z.number().describe("the number of tokens to send"),
    }),
  },
);

const { session } = await client.proxy.openSession({
  label: "live-agent-arg-policy",
  externalRef: "wallet-thread-1",
});
console.log(`proxy session ${session.id} opened`);

const governedTransfer = governLangChainTool(
  client,
  { sessionId: session.id, agentName: "wallet-agent", skillRef: "transfer@1" },
  transfer,
);
const llm = model.bindTools([governedTransfer]);

async function runAgent(prompt) {
  console.log(`\n>>> user: ${prompt}`);
  const ai = await llm.invoke([new HumanMessage(prompt)]);
  const calls = ai.tool_calls ?? [];
  if (calls.length === 0) {
    console.log(`agent answered without calling a tool: ${ai.content}`);
    return;
  }
  for (const call of calls) {
    if (call.name !== "transfer") continue;
    console.log(`agent decided: transfer(${JSON.stringify(call.args)})`);
    try {
      const out = await governedTransfer.invoke(call.args);
      console.log(`  ALLOWED — transfer executed: ${JSON.stringify(out)}`);
    } catch (err) {
      if (!(err instanceof GovernanceDeniedError)) throw err;
      console.log(`  BLOCKED by MakerChecker (${err.code}): ${err.reason}`);
    }
  }
}

// 1. Off-allowlist destination (a neutral address so the model's own safety
//    does not preempt the call) -> the agent chooses it, MakerChecker blocks it.
await runAgent("Send 100 tokens to the wallet address 0x9f3b2c1d.");
// 2. On-allowlist destination -> allowed.
await runAgent("Send 100 tokens to the wallet address 0xSAFE.");

await client.proxy.closeSession(session.id);
const verdict = await client.audit.verify();
console.log(`\naudit chain: ok=${verdict.ok} events=${verdict.count}`);
