# @makerchecker/connector-langchain

Governs a LangChain StructuredTool with MakerChecker. `governLangChainTool` returns a tool with the same name and schema as the original. Every `invoke()` runs a MakerChecker check before the tool body and records the result to the hash-chained audit log. A denied check throws `GovernanceDeniedError` and the tool body never runs.

## Install

```bash
pnpm add @makerchecker/connector-langchain @makerchecker/sdk @langchain/core
```

`@langchain/core` (`^1.0.0`) is a peer dependency. The MakerChecker SDK is a direct dependency.

## Use

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createClient } from "@makerchecker/sdk";
import {
  governLangChainTool,
  GovernanceDeniedError,
} from "@makerchecker/connector-langchain";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });

const matchTxns = tool(async ({ statement }) => ({ matched: statement.length }), {
  name: "match_txns",
  description: "Match statement transactions against the ledger.",
  schema: z.object({ statement: z.array(z.string()) }),
});

const { session } = await client.proxy.openSession({ label: "langchain-run" });

const governed = governLangChainTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "txn-match@1" },
  matchTxns,
);

try {
  await governed.invoke({ statement: ["t1", "t2"] }); // checks, runs, records
} catch (err) {
  if (err instanceof GovernanceDeniedError) console.error(`${err.code}: ${err.reason}`);
  else throw err;
}

await client.proxy.closeSession(session.id);
```

`governed` carries the original `name` and `schema`, so it drops into a `ToolNode` or an agent executor in place of `matchTxns`.

## API

```ts
governLangChainTool(client, context, tool): DynamicStructuredTool
  context: { sessionId, agentName, skillRef }

governToolkit(client, context, tools, skillRefs): DynamicStructuredTool[]
  context: { sessionId, agentName }
  skillRefs: (tool) => skillRef  |  Record<toolName, skillRef>
```

`governToolkit` wraps an array of tools under one session and agent. An unmapped tool throws rather than running ungoverned. `GovernanceDeniedError` is re-exported from `@makerchecker/sdk` with fields `code` and `reason`.

A runnable example is in [examples/connectors/langchain/governed-langchain-demo.mjs](../../examples/connectors/langchain/governed-langchain-demo.mjs).

## License

Apache-2.0. See [LICENSE](./LICENSE).
