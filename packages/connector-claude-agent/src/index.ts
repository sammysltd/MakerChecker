/**
 * @makerchecker/connector-claude-agent — wrap, don't migrate.
 *
 * A developer who already has Claude Agent SDK custom tools governs them through
 * MakerChecker with a thin wrapper. Each tool keeps executing inside the Claude
 * Agent SDK; MakerChecker becomes the deny-by-default authorization checkpoint
 * and the hash-chained evidentiary record.
 *
 * `governClaudeTool` builds an SDK tool (via `tool(...)`) whose handler:
 *   1. calls `client.proxy.check` — a deny throws `GovernanceDeniedError`
 *      BEFORE the underlying handler ever runs (deny by default, fail closed);
 *   2. runs the original handler;
 *   3. calls `client.proxy.record` with the output — or, if the handler throws,
 *      records the error and rethrows the original.
 *
 * The result is a normal `SdkMcpToolDefinition`, so it drops straight into
 * `createSdkMcpServer({ name, tools: [...] })` and the agent is unchanged:
 *
 * ```ts
 * import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
 * import { governClaudeTool } from "@makerchecker/connector-claude-agent";
 *
 * const ingest = governClaudeTool(
 *   client,
 *   { sessionId: session.id, agentName: "recon-preparer", skillRef: "csv-ingest@1" },
 *   "csv_ingest",
 *   "Ingest statement CSVs",
 *   { statementPath: z.string() },
 *   async (args) => ({ content: [{ type: "text", text: await readCsv(args) }] }),
 * );
 * const server = createSdkMcpServer({ name: "governed-tools", tools: [ingest] });
 * ```
 */

import {
  tool,
  type AnyZodRawShape,
  type InferShape,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { type Client, GovernanceDeniedError, type ProxyRecordInput } from "@makerchecker/sdk";

export { GovernanceDeniedError } from "@makerchecker/sdk";

/**
 * The MCP tool result a Claude Agent SDK tool handler returns. Derived from the
 * SDK's exported tool-definition type (the SDK does not re-export the underlying
 * CallToolResult), so the connector needs no direct @modelcontextprotocol/sdk dep.
 */
type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

/**
 * Identifies the governed call to MakerChecker:
 * - `sessionId`  — an open proxy session (`client.proxy.openSession`);
 * - `agentName`  — the registered agent whose role grants are evaluated;
 * - `skillRef`   — the `name@version` of the skill this tool maps to.
 */
export interface GovernContext {
  sessionId: string;
  agentName: string;
  skillRef: string;
}

/**
 * Coerce a thrown value into the shape `client.proxy.record` accepts as
 * `error`. Mirrors the SDK's `governedTool` so the audit record is identical
 * whether the throw was an `Error` or a bare value.
 */
function toRecordedError(err: unknown): NonNullable<ProxyRecordInput["error"]> {
  return { message: err instanceof Error ? err.message : String(err) };
}

/** True for plain object inputs that the proxy `check` can record as `input`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wrap a Claude Agent SDK custom tool so every invocation passes through
 * MakerChecker. The returned `SdkMcpToolDefinition` preserves the original
 * `name`, `description`, and `inputSchema`, so the agent's tool spec is
 * identical to the ungoverned tool. Behaviourally, the handler is governed:
 *
 *   check (deny -> throw, handler never runs) -> run -> record output
 *   handler throws -> record error -> rethrow original
 *
 * @throws {GovernanceDeniedError} when MakerChecker denies the call.
 */
export function governClaudeTool<Schema extends AnyZodRawShape>(
  client: Client,
  context: GovernContext,
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<ToolResult>,
): SdkMcpToolDefinition<Schema> {
  const { sessionId, agentName, skillRef } = context;

  return tool(name, description, inputSchema, async (args, extra) => {
    const check = await client.proxy.check(sessionId, {
      agentName,
      skillRef,
      ...(isRecord(args) ? { input: args } : {}),
    });
    if (!check.allowed) {
      // Fail closed: the underlying handler is NEVER invoked on a deny.
      throw new GovernanceDeniedError(check.code, check.reason);
    }
    try {
      const output = await handler(args, extra);
      await client.proxy.record(sessionId, { checkId: check.checkId, output });
      return output;
    } catch (err) {
      await client.proxy.record(sessionId, {
        checkId: check.checkId,
        error: toRecordedError(err),
      });
      throw err;
    }
  });
}
