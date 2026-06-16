# Governed LangChain — wrap, don't migrate

You already have LangChain tools and a LangGraph graph. You do **not** want to
re-platform onto another orchestrator just to get governance. This connector
inverts that: **LangChain keeps executing your tools; MakerChecker becomes the
deny-by-default authorization checkpoint and the hash-chained evidentiary
record.**

`governLangChainTool(client, { sessionId, agentName, skillRef }, tool)` from
[`@makerchecker/connector-langchain`](../../../packages/connector-langchain)
takes a real `StructuredTool` / `DynamicStructuredTool` and returns a new tool
with the **same `name`, `description`, and `schema`** — a drop-in replacement
for any `ToolNode` or agent executor. Its `invoke()`:

1. `client.proxy.check` — a deny throws `GovernanceDeniedError` **before your
   tool runs** (deny by default, fail closed);
2. runs your original tool inside LangChain;
3. `client.proxy.record` — records the output, or the error (which is rethrown).

`governToolkit(...)` maps the same wrapper over an array of tools, one
`skillRef` per tool (an unmapped tool fails closed).

## Run it

```bash
# 1. A MakerChecker server with the seeded demo (docker compose up), and either
#    MAKERCHECKER_AUTH_DISABLED=1 on the server or MAKERCHECKER_API_KEY set here.
# 2. Build the workspace packages the demo imports from dist:
pnpm --filter @makerchecker/sdk --filter @makerchecker/connector-langchain build
# 3. Install this example's own deps (@langchain/core, zod):
cd examples/connectors/langchain && pnpm install --ignore-workspace
# 4. Run:
MAKERCHECKER_URL=http://localhost:3000 node governed-langchain-demo.mjs
```

The demo opens a proxy session, wraps two real LangChain tools, makes one
ALLOWED call (`recon-preparer` holds `txn-match@1`) and one DENIED call
(`recon-preparer` was never granted `report-gen@1` — the tool body never runs),
then prints the session's audit trail and verifies the chain.
