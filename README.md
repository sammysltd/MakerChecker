# MakerChecker

[![CI](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml/badge.svg)](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sammysltd/makerchecker?label=release)](https://github.com/sammysltd/makerchecker/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20core%20%2B%20Apache--2.0%20SDK-informational)](LICENSING.md)

> **Your AI agent moved the money. No one approved it.**

That is the failure MakerChecker exists to stop. The moment you let an agent act, you lose the second set of eyes that every regulated process assumes is there.

**Maker-checker for AI agents.** The agent that proposes an action cannot be the one that approves it. An independent human signs off before the action runs, and every decision lands in a hash-chained, signed, offline-verifiable record. Open source, self-hosted, framework-agnostic.

**[Try the live demo →](https://makerchecker.ai/demo/)** Watch an agent get blocked from approving its own work, a human sign off, and the audit chain verify, in your browser, no signup.

![Run viewer](docs/assets/demo.gif)

## In one breath

- **Who it's for:** teams running AI agents on consequential actions (payments, alert escalation, case decisions) where someone will eventually ask "who approved this?"
- **What it does:** the agent proposes, an independent human approves, the action runs only then. Deny by default. The same actor can never be both maker and checker.
- **What you walk away with:** a hash-chained, Ed25519-signed evidence bundle a regulator, an auditor, or opposing counsel can verify with no access to your systems.
- **Why not your framework's built-in approvals:** those live inside one runtime and ask you to trust their logs. MakerChecker is one authorization plane and one verifiable audit chain across every framework you run ([more](#why-not-the-built-in-approvals-your-framework-already-has)).
- **How to try it:** `docker compose up`, then drive a seeded reconciliation flow that parks at a human gate ([Quickstart](#quickstart)).

## Start where your agents are

Your agents already live in LangGraph, CrewAI, or the Claude Agent SDK. Don't migrate them, wrap them. A proxy session makes MakerChecker the authorization checkpoint and the evidentiary record while your framework keeps executing the tools.

For LangChain/LangGraph there is a real connector, [`@makerchecker/connector-langchain`](packages/connector-langchain): it wraps a `StructuredTool` and returns a governed tool with the **same name, description, and schema**, a drop-in for any `ToolNode` or agent executor.

```js
import { createClient } from "@makerchecker/sdk";
import { governLangChainTool } from "@makerchecker/connector-langchain";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "langgraph-run" });

// Wrap the LangChain tool you already have, no re-platforming, schema preserved:
const governedMatch = governLangChainTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "txn-match@1" },
  matchTxns, // your existing DynamicStructuredTool
);
// new ToolNode([governedMatch]) - the graph is unchanged.
```

Any other framework wraps a plain function with `governedTool` from the SDK. Every call now gets a deny-by-default grant check, segregation-of-duties enforcement across the session, and a hash-chained audit entry; denied calls throw `GovernanceDeniedError` before your tool runs. Runnable LangChain demo: [examples/connectors/langchain](examples/connectors/langchain/README.md). Other framework recipes: [examples/middleware](examples/middleware/README.md).

## Why

- **Authorization is structural, not statistical.** Agents hold roles, roles hold versioned skill grants, deny by default. The same agent provably cannot be maker and checker on one run.
- **Every action lands in a hash-chained audit log.** Export a signed bundle a regulator can verify offline, with no access to your systems.
- **Human approval gates are flow steps, not afterthoughts.** High-risk skills cannot run without one.

## Why not the built-in approvals your framework already has?

Most agent frameworks ship some kind of human-in-the-loop pause. Two things they don't give you:

- **A cross-platform system of record.** Built-in approvals live inside one framework's runtime. The moment you run agents across LangGraph *and* CrewAI *and* the Claude Agent SDK, you have three approval mechanisms and no single ledger of who was allowed to do what, when, and who signed off. MakerChecker is one authorization plane and one audit chain across all of them.
- **Evidence that doesn't require trusting you.** "Trust our logs" is not independent verification. A framework's approval record is a row in a database the same process can rewrite. MakerChecker's chain is genesis-rooted, hash-linked, append-only at the trigger and privilege level, and exported under a signature you can verify with no access to the running system. The point is precisely that a third party does not have to take your word for it.

Built-in approvals are a feature inside one loop. A maker-checker control plane that survives an examiner, a lawsuit, or a swap of agent framework is a different thing, and not one a single framework's pause can be.

## Graduate to fully-governed orchestration

Proxy sessions govern tools inside someone else's loop, which is exactly why high-risk skills are refused there. When a workflow needs a human gate, run it as a governed flow: sequential agent steps and approval gates, versioned and immutable once published, with the same audit chain underneath.

- **Approval gates** park the run until a human decides; rejection fails the run.
- **n-of-m named approvals**: quorums, named approver lists, and requester-cannot-approve by default. Unauthenticated or out-of-list decisions fail closed.
- **Role limits & budgets**: per-skill invocation caps, amount ceilings that fail closed on unreadable inputs, run-level invocation and token budgets.

One evidentiary spine on both paths: a hash-chained, append-only log and a signed, offline-verifiable export.

## Quickstart

```bash
docker compose up
```

This boots Postgres and the server on `:3000`. The compose file sets `MAKERCHECKER_SEED_DEMO=1` and `DEMO_DATA_DIR`, so first boot seeds two demos and prints a demo admin API key and a demo officer API key once.

**Daily Cash Reconciliation**: a preparer agent, a reporter agent, a maker-checker SoD constraint, and two planted exceptions in the data, `T-1009`, a supplier payment booked as −7800.00 on the statement but −7080.00 in the ledger (a transposition typo), and `T-1012`, an unidentified credit on the statement that is missing from the ledger entirely. **AML Alert Triage**: an analyst agent escalates two planted alerts (a structuring pattern, a sanctions near-match) and the run parks at a BSA-officer gate the requester cannot approve, see [the AML walkthrough](examples/aml-alert-triage/README.md).

Copy the admin API key from the boot logs and pass it as a Bearer token, or set `MAKERCHECKER_AUTH_DISABLED=1` on the server for keyless local use. The admin key triggers runs and approves the cash-reconciliation gate; the AML flow's BSA-officer gate is identity-mode (the requester cannot approve it), so decide that one with the demo officer API key.

```bash
export H='authorization: Bearer mk_...'   # key printed at first boot

# trigger the flow
curl -X POST localhost:3000/api/flows/daily-cash-reconciliation/runs -H "$H" -H 'content-type: application/json' -d '{}'

# it parks at the human gate; find the approval and decide it
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"Both exceptions explained"}'

# inspect every step, skill call, and gate decision
curl localhost:3000/api/runs/<runId> -H "$H"

# verify the audit chain end to end
curl localhost:3000/api/audit/verify -H "$H"
```

Set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` to run the agents on a real model deciding which granted skills to call. Omit both and steps execute deterministically, so the demo works fully air-gapped. More: [docs/quickstart.md](docs/quickstart.md) and [the demo walkthrough](examples/daily-cash-reconciliation/README.md), including the seeded `self-approval-attempt` flow that SoD blocks live.

The quickstart connects as the DB owner for simplicity. For tamper-resistance against a compromised application credential, run the server as a non-owner role that cannot disable the append-only audit triggers: [`ops/harden-db.sql`](ops/harden-db.sql) + [`docker-compose.hardened.yml`](docker-compose.hardened.yml), walkthrough in [docs/db-hardening.md](docs/db-hardening.md).

## How it works

Six primitives, all Postgres-backed, all versioned. Full reference: [docs/concepts.md](docs/concepts.md).

| Primitive | What it is |
|---|---|
| **Agent** | An identity with exactly one role and a lifecycle (`active`/`suspended`/`retired`). Like an employee. |
| **Role** | The permission boundary. Holds versioned skill grants (deny by default), SoD constraints against other roles, and enforced limits & budgets. |
| **Skill** | A versioned, schema-typed capability (MCP, HTTP, or local) with a risk tier. Immutable once published. |
| **Trigger** | What starts a flow: cron, event, or manual/API. |
| **Flow** | A versioned, sequential definition of agent steps and human approval gates. Immutable once published. |
| **Run / Audit** | One execution of a flow. Every transition lands in a hash-chained, append-only audit log, exportable as a signed offline-verifiable bundle. |

## What makes it different

| | MakerChecker | Cordum | Galileo Agent Control | Observability tools |
|---|---|---|---|---|
| Deny-by-default grant ledger | Versioned grants per role; full permission history reconstructable | Allow-unless-policy-hits; agent identity is enterprise-paywalled | None, content rules, not permissions | None |
| Runtime SoD enforcement | Declared role-pair constraints, enforced structurally at execution | Multi-approver routing only | None | None |
| Signed offline-verifiable export | Core feature, [open spec](docs/audit-spec.md) | Hash chain claimed, no published spec, no signed export | None | Logs and traces, not evidence |
| License | AGPL-3.0 core, Apache-2.0 SDK and examples | BUSL-1.1 | Apache 2.0 (Cisco-owned) | Varies |

Guardrail products answer "is this content dangerous?" MakerChecker answers "is this actor authorized, and who approved it?" An agent that passes every content check can still execute a payment it was never authorized to touch. The two compose: run guardrails on content, run MakerChecker on authority.

## Why now

On April 17, 2026 the Federal Reserve replaced SR 11-7 with SR 26-2, which explicitly scopes agentic AI out of model-risk guidance. There is currently no supervisory template for agent controls, and no rules means no safe harbor: examiners and discovery still demand evidence, and the predicate rules (21 CFR Part 11, 21 CFR 211.22, SOX, NYDFS Part 504) are date-proof. The EU AI Act's Annex III high-risk obligations moved from August 2, 2026 to December 2, 2027 (Digital Omnibus, May 7, 2026); the evidence demand did not move with them. When there are no rules, the defensible position is a verifiable record.

## Status

**1.0.0.** Stable public API, flow grammar, and audit-bundle format, under semantic versioning. The [audit chain spec](docs/audit-spec.md) is published for independent offline verification, the security model and hardened production deployment are documented in [SECURITY.md](SECURITY.md), and security reports are welcome.

**Works today:**

- roles, agents, and versioned skills (MCP/HTTP/local) with risk tiers; deny-by-default grants with revocation
- SoD constraints enforced at both decision and invocation time
- flows with approval gates, retries, timeouts, and a crash-recovery watchdog
- n-of-m named approvals: quorums, named approver lists, requester self-approval forbidden by default (fail closed)
- enforced role limits & budgets: per-skill invocation caps, fail-closed amount ceilings, run-level invocation and token budgets
- proxy sessions wrapping LangGraph/CrewAI/Claude Agent SDK agents with grant checks, SoD, and the audit trail, no migration into the flow engine; typed connectors for [LangChain](packages/connector-langchain) ([demo](examples/connectors/langchain/README.md)) and the [Claude Agent SDK](packages/connector-claude-agent), plus generic [middleware recipes](examples/middleware/README.md)
- hash-chained audit log with Ed25519-signed export bundles and a CLI verifier
- evidence packs: `makerchecker audit report --run <id>` renders a self-contained HTML run report with chain verification; `makerchecker audit access-review` renders the role/grant/SoD review (also JSON at `/api/reports/access-review`)
- cron triggers scheduled at boot (runs start as `system/cron` from the latest published version)
- HMAC-signed outbound webhooks with retries and a failure counter
- overdue-approval alerts (`approval.overdue` audit event + webhook, fired once per approval by the watchdog; the approvals API reports `overdue` and `age_seconds`)
- Prometheus `/metrics` endpoint (opt-in via `MAKERCHECKER_METRICS=1`)
- real-model execution (Anthropic, Gemini/OpenAI-compatible) with a deterministic air-gapped fallback
- API-key auth; React UI (run viewer, approvals inbox, registry); typed SDK; OpenAPI document at `/api/openapi.json`; configurable redaction applied at write to llm/skill audit payloads and at read to run detail and evidence packs

## License

- `packages/server`, `packages/web`, `packages/shared`: **AGPL-3.0** ([LICENSE](LICENSE))
- `packages/sdk`, `packages/connector-langchain`, `packages/connector-claude-agent`, and `examples/`: **Apache-2.0** ([packages/sdk/LICENSE](packages/sdk/LICENSE), [packages/connector-langchain/LICENSE](packages/connector-langchain/LICENSE), [packages/connector-claude-agent/LICENSE](packages/connector-claude-agent/LICENSE), [examples/LICENSE](examples/LICENSE)), code you embed in your own systems never carries AGPL obligations
- A **commercial license** (no copyleft obligation) is available for organizations whose policies preclude AGPL-3.0: hello@makerchecker.ai

Licensing rationale and the commercial/CLA model: [LICENSING.md](LICENSING.md). The audit chain is specified for independent offline verification ([audit spec](docs/audit-spec.md)); security reports are welcome ([SECURITY.md](SECURITY.md)).

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · Changelog: [CHANGELOG.md](CHANGELOG.md) · Starter issues: [docs/good-first-issues.md](docs/good-first-issues.md)
