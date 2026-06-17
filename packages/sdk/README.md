# @makerchecker/sdk

Typed TypeScript client for the MakerChecker API, wrapping the HTTP API of [`packages/server`](../server). Exports `governedTool`, which routes a tool function through a proxy session so each call is authorized and recorded. ES module on the host `fetch`; runs on Node 18+ and in browsers.

## Install

```bash
pnpm add @makerchecker/sdk
```

## Use

```ts
import { createClient, governedTool, GovernanceDeniedError } from "@makerchecker/sdk";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "my-agent-run" });

const ingest = governedTool(client, session.id, "recon-preparer", "csv-ingest@1", readCsvFiles);

try {
  await ingest({ source: "bank_statement.csv" });
} catch (err) {
  if (err instanceof GovernanceDeniedError) console.log(`denied (${err.code}): ${err.reason}`);
  else throw err;
}

await client.proxy.closeSession(session.id);
```

## Resource methods

`createClient({ baseUrl, apiKey?, fetch? })` returns a client. Each method runs one HTTP request and returns a typed `Promise`. A non-2xx response throws `ApiError` with `status` and `body`.

```ts
await client.health();                              // { status, schemaVersion }
await client.flows.trigger(name, input?);           // { runId }
await client.runs.list();                           // { runs: RunSummary[] }
await client.runs.get(id);                          // RunDetail
await client.approvals.list();                      // { approvals: PendingApproval[] }
await client.approvals.decide(id, "approved", reason?);
await client.agents.list();
await client.agents.create({ name, roleName });     // also accepts roleId, modelConfig
await client.agents.get(id);                        // AgentDetail
await client.agents.setStatus(id, "suspended");
await client.roles.list();
await client.roles.create({ name, limits });        // limits: per-skill role limit map
await client.skills.list();
await client.skills.publish({ name, version, description, inputSchema, outputSchema, implementation, riskTier });
await client.skills.deprecate(id);
await client.grants.create({ roleId, skillId });
await client.grants.revoke(id);
await client.audit.verify();                        // walks the hash chain, reports if intact
await client.proxy.openSession({ label, externalRef? });
await client.proxy.check(sessionId, { agentName, skillRef, input? });
await client.proxy.record(sessionId, { checkId, output?, error? });
await client.proxy.closeSession(sessionId);
await client.proxy.getSession(sessionId);           // ProxySessionDetail
```

## governedTool

`governedTool(client, sessionId, agentName, skillRef, fn): (input) => Promise<output>` returns a function with the same input shape as `fn`. Each call runs `proxy.check`, throws `GovernanceDeniedError` (with `code` and `reason`) on denial, executes `fn`, then records the output. If `fn` throws, the error is recorded and rethrown.

Framework adapters: [`packages/connector-langchain`](../connector-langchain), [`packages/connector-claude-agent`](../connector-claude-agent). Worked examples: [`examples/middleware/README.md`](../../examples/middleware/README.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
