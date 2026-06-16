import type {
  AssistantBlock,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMTurn,
  StopReason,
} from "./provider.js";

export interface OpenAICompatibleOptions {
  baseURL: string; // e.g. https://api.openai.com/v1 or http://localhost:11434/v1
  apiKey?: string;
  fetch?: typeof fetch;
}

interface OAIToolCall {
  id: string;
  function: { name: string; arguments: string };
  [extra: string]: unknown; // e.g. Gemini's thought_signature
}

interface OAIResponse {
  choices: Array<{
    message: { content: string | null; tool_calls?: OAIToolCall[] };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Covers OpenAI plus any OpenAI-compatible endpoint (Ollama, vLLM, etc.). */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly baseURL: string;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, "");
  }

  async complete(req: LLMRequest): Promise<LLMTurn> {
    const doFetch = this.options.fetch ?? fetch;
    const res = await doFetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          ...req.messages.flatMap(toOAIMessages),
        ],
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                },
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM endpoint returned ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as OAIResponse;
    const choice = body.choices[0];
    if (!choice) throw new Error("LLM endpoint returned no choices");

    const content: AssistantBlock[] = [];
    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }
    for (const call of choice.message.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments) as Record<string, unknown>,
        // Preserve the raw tool_call so replay echoes provider extras
        // (Gemini's thought_signature etc.) byte-for-byte.
        providerMeta: { raw: call },
      });
    }

    return {
      stopReason: mapFinishReason(choice.finish_reason),
      content,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }
}

type OAIMessage = Record<string, unknown>;

function toOAIMessages(message: LLMMessage): OAIMessage[] {
  if (message.role === "assistant") {
    const text = message.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls = message.content
      .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
      .map(
        (b) =>
          (b.providerMeta?.raw as OAIToolCall | undefined) ?? {
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          },
      );
    return [
      {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    ];
  }

  // User turns: tool results become individual `tool` role messages.
  const out: OAIMessage[] = [];
  const textParts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") textParts.push(block.text);
    if (block.type === "tool_result") {
      out.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content });
    }
  }
  if (textParts.length) out.unshift({ role: "user", content: textParts.join("\n") });
  return out;
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}
