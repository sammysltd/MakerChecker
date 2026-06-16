/**
 * Provider-agnostic LLM interface. Implementations: AnthropicProvider
 * (official SDK) and OpenAICompatibleProvider (covers OpenAI, Ollama, vLLM
 * via a configurable base URL). The engine depends only on this interface.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Opaque provider-specific payload that must be echoed back verbatim when
   * the block is replayed (e.g. Gemini's thought_signature on tool calls).
   * Providers own its shape; the engine never inspects it.
   */
  providerMeta?: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type AssistantBlock = TextBlock | ToolUseBlock;
export type MessageBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface LLMMessage {
  role: "user" | "assistant";
  content: MessageBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export interface LLMTurn {
  stopReason: StopReason;
  content: AssistantBlock[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LLMRequest {
  model: string;
  system: string;
  messages: LLMMessage[];
  tools: ToolDef[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMTurn>;
}
