# MakerChecker

[![CI](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml/badge.svg)](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sammysltd/makerchecker?label=release)](https://github.com/sammysltd/makerchecker/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20core%20%2B%20Apache--2.0%20SDK-informational)](LICENSING.md)

**Website: [makerchecker.ai](https://makerchecker.ai)**

**Your AI agent moved the money. No one approved it.**

MakerChecker is self-hosted software that governs AI agents through **structural enforcement** and **human approvals**. Structural enforcement runs at machine speed with no human in the path: an agent acts only through a **role**, runs only the skills its role was **granted** (deny by default, pinned to an exact version), cannot exceed its limits, and provably cannot approve its own work. Human approval is reserved for the few high-risk actions where a rule requires a named person to sign. Every action commits to a hash-chained, Ed25519-signed **audit log** that anyone verifies offline. Change one row and verification breaks at it.

Your agents keep running in their existing framework. MakerChecker is the checkpoint in front of them and the record behind them: a Fastify server on Postgres. Agents connect as a **flow** (MakerChecker runs the steps and gates) or a **proxy session** (MakerChecker authorizes and records tool calls your framework executes). Both write the same audit chain.

**New here?** Operator → [Quickstart](#quickstart). Integrator → [Integration](#integration). Security reviewer → [docs/security-model.md](docs/security-model.md). Examiner → [docs/audit-spec.md](docs/audit-spec.md). GRC analyst → [docs/compliance/control-mapping.md](docs/compliance/control-mapping.md).

[Live demo](https://makerchecker.ai/demo/): an agent is blocked from exceeding its grant and from approving its own work, the run's audit chain verifies offline, and a named human signs off only where a rule requires it. No signup.

![Run viewer](docs/assets/demo.gif)

## How it works

- **Grant.** Bind a role to exact skill versions. Nothing else runs.
- **Check.** Every tool call hits the gate first. No grant, over a limit, or against an SoD constraint, and it is denied before the tool body runs.
- **Gate.** High-risk steps wait for named human approval. The requester cannot approve their own.
- **Record.** State changes and tool calls commit to the audit chain in the same transaction, each event chained to the last by hash.

Every refusal is named and audited:

| Control | Refusal |
|---|---|
| Skill not granted to the role | `skill_not_granted` |
| Over a per-invocation amount or count limit (fails closed) | `limit_amount`, `limit_invocations` |
| A conflicting role already acted in the run (segregation of duties) | `enforcement.sod_violation` |
| High-risk skill with no preceding gate | `high_risk_requires_gate` |
| Any altered audit row | `audit verify` → `{ ok: false, failedSeq }` |

## Quickstart

```bash
docker compose up
```

Postgres and the server come up on port 3000. First boot seeds the demo and prints an admin key and an officer key — copy them from the logs.

On a production (non-demo) deployment nothing is seeded; mint the first admin and its API key explicitly with `node dist/cli.js bootstrap-admin --email <e> --name <n>` (printed once). See [First admin on a fresh deployment](docs/quickstart.md#first-admin-on-a-fresh-deployment).

A cash-reconciliation flow with a maker-checker constraint is seeded and ready:

```bash
export H='authorization: Bearer mk_...'   # admin key from the logs

# Trigger the flow
curl -X POST localhost:3000/api/flows/daily-cash-reconciliation/runs -H "$H" -H 'content-type: application/json' -d '{}'

# Inspect the pending approval gate
curl localhost:3000/api/approvals -H "$H"

# Approve the gate
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"Exceptions resolved"}'

# Verify the audit chain
curl localhost:3000/api/audit/verify -H "$H"
```

Full local setup, and running with real models, is in [docs/quickstart.md](docs/quickstart.md).

The quickstart connects as the Postgres owner, which disables the append-only audit triggers. For tamper-resistance against a compromised app credential, run the server as a non-owner role with [`docker-compose.hardened.yml`](docker-compose.hardened.yml) ([walkthrough](docs/security-model.md#database-hardening-walkthrough)).

## Packages

pnpm workspaces with Turborepo. The server is AGPL-3.0; the SDKs and connectors are Apache-2.0, so you can embed them in closed-source code.

| Package | License | What it is |
|---|---|---|
| [`packages/server`](packages/server) | AGPL-3.0 | Fastify API, flow engine, workers, audit writer, demo seed, `cli.js` admin tool. |
| [`packages/web`](packages/web) | AGPL-3.0 | Vite/React SPA: run viewer, approvals inbox, registry. |
| [`packages/shared`](packages/shared) | AGPL-3.0 | Domain types, TypeBox schemas, RFC 8785 canonical JSON, hash utilities. |
| [`packages/sdk`](packages/sdk) | Apache-2.0 | Typed TypeScript HTTP client plus the `governedTool` wrapper. |
| [`packages/sdk-python`](packages/sdk-python) | Apache-2.0 | Typed Python HTTP client plus `governed_tool`. |
| [`packages/connector-langchain`](packages/connector-langchain) | Apache-2.0 | `governLangChainTool` / `governToolkit` for LangChain `StructuredTool`s. |
| [`packages/connector-claude-agent`](packages/connector-claude-agent) | Apache-2.0 | `governClaudeTool` for Claude Agent SDK custom tools. |

The governed primitives — Agent, Role, Skill, Trigger, Flow, Run/Audit — are Postgres-backed and versioned. See [docs/concepts.md](docs/concepts.md).

## Integration

Open a proxy session, then wrap each tool. Every call runs `proxy.check` (a deny throws `GovernanceDeniedError` before the tool runs), executes the tool, then records the output. High-risk skills are refused on the proxy path; they need a flow gate.

```ts
import { createClient, governedTool, GovernanceDeniedError } from "@makerchecker/sdk";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "recon-run" });

const match = governedTool(
  client,
  session.id,
  "recon-preparer",   // registered agent whose role grants are evaluated
  "txn-match@1",       // skillRef: name@version
  (input: { statement: unknown[]; ledger: unknown[] }) => matchTxns(input),
);

await match({ statement, ledger }); // throws GovernanceDeniedError if denied
await client.proxy.closeSession(session.id);
```

Connectors keep your tool's name, description, and schema:

- **LangChain** — `governLangChainTool` returns a `DynamicStructuredTool`. See [examples/connectors/langchain](examples/connectors/langchain/README.md).
- **Claude Agent SDK** — `governClaudeTool` returns an `SdkMcpToolDefinition` for `createSdkMcpServer`. See [packages/connector-claude-agent](packages/connector-claude-agent/README.md).
- **Python** (CrewAI, LangChain, LlamaIndex, AutoGen) — `create_client` then `governed_tool`; `pip install makerchecker`. See [packages/sdk-python](packages/sdk-python/README.md).

## Audit and verification

Every state transition emits an audit event in the same transaction as the state write. Each event's hash is SHA-256 over the RFC 8785 canonical JSON of the event (excluding `seq`), chained through `prev_hash` from a genesis event tied to the instance. Change any row and recomputation breaks at it.

`GET /api/audit/verify` walks the chain and returns `{ ok, count, headHash }`, or `{ ok: false, failedSeq, reason }` on a break. The CLI verifies the live chain and signed bundles offline:

```bash
# verify against the running database
docker compose exec server node dist/cli.js audit verify

# export a signed bundle, then verify it with no database
docker compose exec server node dist/cli.js audit export --out bundle.json
node dist/cli.js audit verify-bundle --in bundle.json
node dist/cli.js audit verify-bundle --in bundle.json --key instance.pub  # pin the key
```

Bundles are Ed25519-signed and carry the manifest needed to recompute the chain. The format is specified in [docs/audit-spec.md](docs/audit-spec.md) for reimplementation in any language. `audit report --run <id>` builds a self-contained HTML run report; `audit access-review` renders the role/grant/SoD review (also at `/api/reports/access-review`).

The chain is the system of record, so back it up like one: [docs/backup-restore.md](docs/backup-restore.md) covers database backup, PITR, escrowing the write-once signing key separately, and a restore drill that ends in `audit verify`.

## Status

MakerChecker 1.0. The server, web, shared, integration, and verification paths are covered by unit and integration tests against Postgres in CI.

1.0 has no drag-and-drop flow builder, SSO/SAML, or multi-tenancy. Flow definitions are typed JSON/YAML.

## License

Server, web, and shared are AGPL-3.0 ([LICENSE](LICENSE)). The SDKs, connectors, and examples are Apache-2.0 — import and ship them in closed-source products without copyleft. A commercial license is available for organizations that cannot use AGPL-3.0: hello@makerchecker.ai. Details: [LICENSING.md](LICENSING.md).

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · Changelog: [CHANGELOG.md](CHANGELOG.md)
