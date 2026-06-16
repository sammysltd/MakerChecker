import { describe, expect, it, vi } from "vitest";

import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { LLMRequest } from "./provider.js";
import { exampleRegexRedactor, noRedaction } from "./redaction.js";

const REQ: LLMRequest = {
  model: "claude-opus-4-8",
  system: "You are an agent.",
  messages: [
    { role: "user", content: [{ type: "text", text: "Match the transactions." }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Calling the matcher." },
        { type: "tool_use", id: "t1", name: "match-txns__v1", input: { file: "a.csv" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "t1", content: '{"matched":41}', isError: false },
      ],
    },
  ],
  tools: [
    {
      name: "match-txns__v1",
      description: "Match transactions",
      inputSchema: { type: "object", properties: { file: { type: "string" } } },
    },
  ],
  maxTokens: 4096,
  signal: new AbortController().signal,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("AnthropicProvider", () => {
  it("maps requests to the Messages API shape and parses tool_use turns", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body);
      expect(body.model).toBe("claude-opus-4-8");
      expect(body.max_tokens).toBe(4096);
      expect(body.system).toBe("You are an agent.");
      expect(body.tools).toEqual([
        {
          name: "match-txns__v1",
          description: "Match transactions",
          input_schema: { type: "object", properties: { file: { type: "string" } } },
        },
      ]);
      expect(body.messages[1].content[1]).toEqual({
        type: "tool_use",
        id: "t1",
        name: "match-txns__v1",
        input: { file: "a.csv" },
      });
      expect(body.messages[2].content[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "t1",
      });
      return jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [
          { type: "text", text: "Now reporting." },
          { type: "tool_use", id: "t2", name: "match-txns__v1", input: { file: "b.csv" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 321, output_tokens: 45 },
      });
    });

    const provider = new AnthropicProvider({ apiKey: "test-key", fetch: fetchMock as typeof fetch });
    const turn = await provider.complete(REQ);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.content).toEqual([
      { type: "text", text: "Now reporting." },
      { type: "tool_use", id: "t2", name: "match-txns__v1", input: { file: "b.csv" } },
    ]);
    expect(turn.usage).toEqual({ inputTokens: 321, outputTokens: 45 });
  });

  it("maps end_turn and refusal stop reasons", async () => {
    const respond = (stop_reason: string) =>
      vi.fn(async () =>
        jsonResponse({
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "done" }],
          stop_reason,
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );

    for (const [apiReason, mapped] of [
      ["end_turn", "end_turn"],
      ["refusal", "refusal"],
      ["max_tokens", "max_tokens"],
    ] as const) {
      const provider = new AnthropicProvider({
        apiKey: "k",
        fetch: respond(apiReason) as unknown as typeof fetch,
      });
      expect((await provider.complete(REQ)).stopReason).toBe(mapped);
    }
  });
});

describe("OpenAICompatibleProvider", () => {
  it("maps requests to chat/completions and parses tool calls", async () => {
    const fetchMock = vi.fn(async (url: unknown, init: unknown) => {
      expect(String(url)).toBe("http://llm.local/v1/chat/completions");
      const body = JSON.parse((init as { body: string }).body);
      expect(body.messages[0]).toEqual({ role: "system", content: "You are an agent." });
      expect(body.messages[2]).toMatchObject({
        role: "assistant",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "match-txns__v1", arguments: '{"file":"a.csv"}' },
          },
        ],
      });
      expect(body.messages[3]).toEqual({
        role: "tool",
        tool_call_id: "t1",
        content: '{"matched":41}',
      });
      expect(body.tools[0].function.name).toBe("match-txns__v1");
      return jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "c9", function: { name: "match-txns__v1", arguments: '{"file":"b.csv"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 31 },
      });
    });

    const provider = new OpenAICompatibleProvider({
      baseURL: "http://llm.local/v1/",
      apiKey: "k",
      fetch: fetchMock as typeof fetch,
    });
    const turn = await provider.complete(REQ);
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.content).toHaveLength(1);
    expect(turn.content[0]).toMatchObject({
      type: "tool_use",
      id: "c9",
      name: "match-txns__v1",
      input: { file: "b.csv" },
    });
    expect(turn.usage).toEqual({ inputTokens: 200, outputTokens: 31 });
  });

  it("echoes provider extras (Gemini thought_signature) back verbatim on replay", async () => {
    // Turn 1: Gemini returns a tool_call carrying a thought_signature.
    const first = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "g1",
                  thought_signature: "OPAQUE_SIG_BYTES==",
                  function: { name: "match-txns__v1", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {},
      }),
    );
    const provider1 = new OpenAICompatibleProvider({
      baseURL: "http://x",
      fetch: first as unknown as typeof fetch,
    });
    const turn = await provider1.complete(REQ);
    const toolUse = turn.content[0] as { providerMeta?: { raw?: { thought_signature?: string } } };
    expect(toolUse.providerMeta?.raw?.thought_signature).toBe("OPAQUE_SIG_BYTES==");

    // Turn 2: replaying that assistant turn must serialize the RAW tool_call,
    // signature included — Gemini 400s without it.
    const second = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body);
      const assistant = body.messages.find(
        (m: { role: string; tool_calls?: unknown[] }) => m.role === "assistant" && m.tool_calls,
      );
      expect(assistant.tool_calls[0]).toMatchObject({
        id: "g1",
        thought_signature: "OPAQUE_SIG_BYTES==",
      });
      return jsonResponse({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: {},
      });
    });
    const provider2 = new OpenAICompatibleProvider({
      baseURL: "http://x",
      fetch: second as unknown as typeof fetch,
    });
    await provider2.complete({
      ...REQ,
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: turn.content },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "g1", content: "{}" }],
        },
      ],
    });
    expect(second).toHaveBeenCalledOnce();
  });

  it("maps finish reasons and surfaces HTTP errors", async () => {
    const ok = (finish_reason: string) =>
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { content: "hi" }, finish_reason }],
          usage: {},
        }),
      );
    for (const [apiReason, mapped] of [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["content_filter", "refusal"],
    ] as const) {
      const provider = new OpenAICompatibleProvider({
        baseURL: "http://x",
        fetch: ok(apiReason) as unknown as typeof fetch,
      });
      expect((await provider.complete(REQ)).stopReason).toBe(mapped);
    }

    const failing = new OpenAICompatibleProvider({
      baseURL: "http://x",
      fetch: vi.fn(async () => new Response("boom", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(failing.complete(REQ)).rejects.toThrow(/503/);

    const empty = new OpenAICompatibleProvider({
      baseURL: "http://x",
      fetch: vi.fn(async () => jsonResponse({ choices: [] })) as unknown as typeof fetch,
    });
    await expect(empty.complete(REQ)).rejects.toThrow(/no choices/);
  });
});

describe("redaction hooks", () => {
  it("noRedaction is identity", () => {
    const payload = { a: 1, email: "x@y.com" };
    expect(noRedaction(payload)).toBe(payload);
  });

  it("exampleRegexRedactor masks emails and long digit runs, recursively", () => {
    const result = exampleRegexRedactor({
      note: "wire to alice@bank.example acct 123456789012",
      nested: { list: ["bob@x.io", 42, null, { deep: "9999888877776666" }] },
      short: "12345",
    });
    expect(result).toEqual({
      note: "wire to [REDACTED:email] acct [REDACTED:number]",
      nested: { list: ["[REDACTED:email]", 42, null, { deep: "[REDACTED:number]" }] },
      short: "12345",
    });
  });
});
