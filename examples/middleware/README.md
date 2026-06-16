# Governance middleware: wrap, don't migrate

You already have agents — LangGraph graphs, CrewAI crews, Claude Agent SDK
loops. Rewriting them into another orchestrator to get governance is a
non-starter. Proxy sessions invert that: **your framework keeps executing the
tools; MakerChecker becomes the authorization checkpoint and the evidentiary
record.** Open a session, wrap each tool with `governedTool`, and every call
gets deny-by-default grant checks, segregation-of-duties enforcement across
the session, and a hash-chained audit trail — without touching your agent
logic. High-risk skills are refused in proxy mode entirely; those belong in a
governed flow with a human approval gate.

The wrapper does three things per call: `check` (denied calls throw
`GovernanceDeniedError` before your tool runs), execute your function, then
`record` the output — or the error, which is rethrown.

```js
import { createClient, governedTool } from "@makerchecker/sdk";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "my-agent-run" });
```

## LangGraph

```js
import { tool } from "@langchain/core/tools";

const matchTxns = governedTool(client, session.id, "recon-preparer", "txn-match@1",
  async (input) => runMatcher(input));

const tools = [tool(matchTxns, { name: "txn_match", schema: MatchSchema })];
// graph.addNode("tools", new ToolNode(tools)) — the graph is unchanged.
```

## CrewAI (via a Node tool bridge)

```js
// Expose governed tools to your crew through a custom tool endpoint:
const approveRecon = governedTool(client, session.id, "recon-approver-bot",
  "approve-recon@1", (input) => approve(input));

app.post("/tools/approve_recon", async (req, res) => {
  try { res.json(await approveRecon(req.body)); }
  catch (err) { res.status(403).json({ denied: err.message }); }
});
```

## Claude Agent SDK (custom tools)

```js
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

const ingest = governedTool(client, session.id, "recon-preparer", "csv-ingest@1",
  (input) => readCsvFiles(input));

const server = createSdkMcpServer({
  name: "governed-tools",
  tools: [tool("csv_ingest", "Ingest statement CSVs", IngestSchema,
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await ingest(args)) }] }))],
});
```

Close the session when the run ends (`client.proxy.closeSession(session.id)`)
and pull the full record with `client.proxy.getSession(session.id)`. Runnable
demo against a live server: `node examples/middleware/governed-tool-demo.mjs`.
