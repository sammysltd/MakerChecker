/**
 * @makerchecker/connector-langchain — wrap, don't migrate.
 *
 * A developer who already has LangChain tools governs them through MakerChecker
 * with a thin wrapper. Each tool keeps executing inside LangChain/LangGraph;
 * MakerChecker becomes the deny-by-default authorization checkpoint and the
 * hash-chained evidentiary record.
 *
 * `governLangChainTool` takes a real LangChain `StructuredTool` /
 * `DynamicStructuredTool` and returns a NEW tool with the same name,
 * description, and schema whose `invoke()`:
 *   1. calls `client.proxy.check` — a deny throws `GovernanceDeniedError`
 *      BEFORE the underlying tool ever runs (deny by default, fail closed);
 *   2. runs the original tool;
 *   3. calls `client.proxy.record` with the output — or, if the tool throws,
 *      records the error and rethrows the original.
 *
 * The wrapper never re-platforms the agent: drop the governed tool into the
 * same `ToolNode` / agent and the graph is unchanged.
 */

import {
  type Client,
  GovernanceDeniedError,
  type ProxyRecordInput,
} from "@makerchecker/sdk";
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";

export { GovernanceDeniedError } from "@makerchecker/sdk";

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

/**
 * Wrap a single LangChain tool so every invocation passes through MakerChecker.
 *
 * The returned tool preserves the original `name`, `description`, and `schema`,
 * so it is a drop-in replacement: LangGraph, agent executors, and the LLM tool
 * spec see no difference. Behaviourally, `invoke()` is governed:
 *
 *   check (deny -> throw, tool never runs) -> run -> record output
 *   tool throws -> record error -> rethrow original
 *
 * @throws {GovernanceDeniedError} when MakerChecker denies the call.
 */
export function governLangChainTool<T extends StructuredToolInterface>(
  client: Client,
  context: GovernContext,
  tool: T,
): DynamicStructuredTool {
  const { sessionId, agentName, skillRef } = context;

  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description,
    // Same schema object the underlying tool advertises — the LLM/graph spec
    // is byte-for-byte identical to the ungoverned tool.
    schema: tool.schema,
    func: async (input, _runManager, config) => {
      const check = await client.proxy.check(sessionId, {
        agentName,
        skillRef,
        ...(isRecord(input) ? { input } : {}),
      });
      if (!check.allowed) {
        // Fail closed: the underlying tool is NEVER invoked on a deny.
        throw new GovernanceDeniedError(check.code, check.reason);
      }
      try {
        const output = (await tool.invoke(input, config)) as unknown;
        await client.proxy.record(sessionId, {
          checkId: check.checkId,
          ...(output !== undefined ? { output } : {}),
        });
        return output;
      } catch (err) {
        await client.proxy.record(sessionId, {
          checkId: check.checkId,
          error: toRecordedError(err),
        });
        throw err;
      }
    },
  });
}

/** True for plain object inputs that the proxy `check` can record as `input`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map `governLangChainTool` over an array of tools, sharing one
 * {@link GovernContext.sessionId} and {@link GovernContext.agentName} but
 * giving each tool its own `skillRef`. `skillRefs` may be:
 *   - a function `(tool) => skillRef`, or
 *   - a record mapping tool `name` -> `skillRef`.
 *
 * Every tool must resolve to a `skillRef`; an unmapped tool fails closed with a
 * thrown error rather than silently running ungoverned.
 */
export function governToolkit<T extends StructuredToolInterface>(
  client: Client,
  context: Omit<GovernContext, "skillRef">,
  tools: readonly T[],
  skillRefs: ((tool: T) => string) | Record<string, string>,
): DynamicStructuredTool[] {
  const resolve =
    typeof skillRefs === "function"
      ? skillRefs
      : (tool: T): string => {
          const ref = skillRefs[tool.name];
          if (ref === undefined) {
            throw new Error(
              `governToolkit: no skillRef mapped for tool "${tool.name}" — ` +
                "deny by default, refusing to govern an unmapped tool",
            );
          }
          return ref;
        };

  return tools.map((tool) =>
    governLangChainTool(client, { ...context, skillRef: resolve(tool) }, tool),
  );
}
