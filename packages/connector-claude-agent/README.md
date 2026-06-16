# @makerchecker/connector-claude-agent

Governs a [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) custom tool with MakerChecker. `governClaudeTool` returns an `SdkMcpToolDefinition` with the same name, description, and input schema. Every invocation runs a deny-by-default check before the handler and records a hash-chained, Ed25519-signed result after it.

## Install

`@anthropic-ai/claude-agent-sdk` (`^0.3.0`) is a peer dependency.

```bash
pnpm add @makerchecker/connector-claude-agent @anthropic-ai/claude-agent-sdk zod
```

## Use

```ts
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createClient } from "@makerchecker/sdk";
import { governClaudeTool } from "@makerchecker/connector-claude-agent";
import { z } from "zod";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "claude-run" });

const ingest = governClaudeTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "csv-ingest@1" },
  "csv_ingest",
  "Ingest the statement CSVs",
  { statementPath: z.string() },
  async (args) => ({ content: [{ type: "text", text: await readCsv(args) }] }),
);

const server = createSdkMcpServer({ name: "governed-tools", tools: [ingest] });
```

A deny throws `GovernanceDeniedError` (re-exported from [@makerchecker/sdk](../sdk)) carrying `code` and `reason`, and the handler never runs. On allow, the handler runs and its output is recorded. If the handler throws, the error is recorded and rethrown.

## API

```ts
function governClaudeTool<Schema extends AnyZodRawShape>(
  client: Client,
  context: GovernContext,
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<ToolResult>,
): SdkMcpToolDefinition<Schema>;

interface GovernContext {
  sessionId: string; // an open proxy session (client.proxy.openSession)
  agentName: string; // the registered agent whose role grants are evaluated
  skillRef: string;  // the "name@version" of the skill this tool maps to
}
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
