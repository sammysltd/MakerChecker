# @makerchecker/connector-claude-agent

Govern [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
custom tools through MakerChecker. Wrap, don't migrate: each tool keeps executing
inside the Claude Agent SDK; MakerChecker becomes the deny-by-default
authorization checkpoint and the hash-chained evidentiary record.

`governClaudeTool` returns a normal `SdkMcpToolDefinition` (same `name`,
`description`, and `inputSchema` as the underlying tool), so it drops straight
into `createSdkMcpServer`. Its handler runs `proxy.check` first (a deny throws
`GovernanceDeniedError` before the tool body runs), then the tool, then
`proxy.record` with the output (or the error, which is rethrown).

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

`@anthropic-ai/claude-agent-sdk` is a peer dependency. Apache-2.0: embedding this
connector in your own systems never carries AGPL obligations.
