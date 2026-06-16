import Anthropic from "@anthropic-ai/sdk";

import type {
  AssistantBlock,
  LLMProvider,
  LLMRequest,
  LLMTurn,
  StopReason,
} from "./provider.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch; // injectable for tests
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client = new Anthropic({
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
  }

  async complete(req: LLMRequest): Promise<LLMTurn> {
    const response = await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content.map((block): Anthropic.ContentBlockParam => {
            switch (block.type) {
              case "text":
                return { type: "text", text: block.text };
              case "tool_use":
                return {
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: block.input,
                };
              case "tool_result":
                return {
                  type: "tool_result",
                  tool_use_id: block.toolUseId,
                  content: block.content,
                  ...(block.isError ? { is_error: true } : {}),
                };
            }
          }),
        })),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
      },
      { signal: req.signal },
    );

    const content: AssistantBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      stopReason: mapStopReason(response.stop_reason),
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}
