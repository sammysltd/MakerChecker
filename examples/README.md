# Examples

Seeded scenario flows, integration demos, and runnable incident scenarios for MakerChecker.

Every demo expects a MakerChecker server on `http://localhost:3000` with the seeded demo data (`docker compose up`). Set `MAKERCHECKER_API_KEY` to the key printed at seed time, or run the server with `MAKERCHECKER_AUTH_DISABLED=1`. Build the workspace packages the scripts import from `dist/` first.

## Seeded scenario flows

Each directory holds the input CSVs for one governed workflow; `daily-cash-reconciliation/` also ships a reference `flow.yaml`. The canonical flow definitions are seeded from `packages/server/src/demo/seed.ts`, and each binds the requester and approver roles so the proposing agent never approves its own action.

- `daily-cash-reconciliation/`: A preparer agent matches the bank statement against the ledger and flags exceptions. A human gate reviews the exceptions, then a reporter agent renders and delivers the summary over MCP. The `self-approval-attempt` flow blocks a self-approval and writes the violation to the audit chain.
- `aml-alert-triage/`: An L1 analyst triages the day's AML alerts (`alerts.csv` plants a structuring pattern and a sanctions near-match). The run parks at a SAR-filing gate for the BSA officer; the analyst who worked an alert cannot approve its disposition.
- `mdr-reportability-triage/`: A complaint analyst triages device complaints (`complaints.csv` plants an insulin-pump over-delivery and a ventilator alarm malfunction). The run parks at a reportability gate for the regulatory officer.
- `pv-icsr-processing/`: A case-processor triages adverse-event cases (`icsr_cases.csv` plants two 15-day expedited cases, one foreign-sourced). The run parks at a medical-review gate.
- `gross-to-net-margin/`: A market analyst extracts the ERP pricing export (`erp_pricing.csv` plants a double-counted discount that drives deductions past 100% of list) and builds the gross-to-net waterfall per market and SKU. The run parks at a margin-certification gate for the finance controller.
- `cold-chain-disposition/`: A monitor agent quarantines a lot after a temperature excursion (`excursions.csv` plus reading and stability-limit data). `quarantine@1` is low risk and runs pre-gate. The release-or-destroy decision uses `disposition-act@1` (high risk), so the flow grammar forces a QA approval gate and rejects any gate-less publish with `high_risk_requires_gate`.

## Runnable demos

### `sdk-demo.mjs`

Drives the Daily Cash Reconciliation flow end to end through the SDK: trigger, poll until `waiting_approval`, approve the gate, print the report output, verify the audit chain. Uses `createClient` from `../packages/sdk/dist/index.js`, then `client.flows.trigger`, `client.runs.get`, `client.approvals.decide(gate.id, "approved", reason)`, and `client.audit.verify()`.

```bash
node examples/sdk-demo.mjs
```

### `middleware/governed-tool-demo.mjs`

Wraps plain functions (standing in for LangGraph or CrewAI tools) with `governedTool` and runs them in a proxy session. The framework executes the tool; MakerChecker runs the grant check, enforces segregation of duties across the session, and records each decision. Shows an allowed call, a deny-by-default denial, then an SoD denial after a conflicting role acted.

```bash
node examples/middleware/governed-tool-demo.mjs
```

`governedTool(client, sessionId, agentName, skillRef, fn)` returns an async function. Each call runs `client.proxy.check` first; a deny throws `GovernanceDeniedError` before `fn` runs. On allow it runs `fn`, records the output or rethrown error, and returns the result.

```js
import { createClient, governedTool, GovernanceDeniedError } from "../../packages/sdk/dist/index.js";

const { session } = await client.proxy.openSession({ label: "external-framework-demo" });
const ingest = governedTool(client, session.id, "recon-preparer", "csv-ingest@1",
  async (input) => ({ rows: 12, source: input.source }));
await ingest({ source: "bank_statement.csv" });   // allowed: role holds the grant
```

See [`middleware/README.md`](middleware/README.md) for LangGraph and CrewAI sketches that use the same wrapper.

### `connectors/langchain/`

Governs real `@langchain/core` tools with [`@makerchecker/connector-langchain`](../packages/connector-langchain). `governLangChainTool(client, { sessionId, agentName, skillRef }, tool)` takes a `StructuredTool` and returns a tool that preserves the original `name`/`description`/`schema`. Its `invoke()` runs the grant check; on allow it runs the original tool and records the output or rethrown error, and a deny throws `GovernanceDeniedError` before the tool body runs. `governToolkit(...)` maps the wrapper over an array of tools, one `skillRef` per tool, and fails closed on any unmapped tool.

```bash
pnpm --filter @makerchecker/sdk --filter @makerchecker/connector-langchain build
cd examples/connectors/langchain && pnpm install --ignore-workspace
MAKERCHECKER_URL=http://localhost:3000 node governed-langchain-demo.mjs
```

```js
import { governLangChainTool, GovernanceDeniedError } from "../../../packages/connector-langchain/dist/index.js";
const governed = governLangChainTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "txn-match@1" },
  matchTxns,                                  // a real @langchain/core tool
);
await governed.invoke({ statement: ["t1", "t2", "t3"] });
```

See [`connectors/langchain/README.md`](connectors/langchain/README.md) for the walkthrough. The Claude Agent SDK wrapper (`governClaudeTool` from [`@makerchecker/connector-claude-agent`](../packages/connector-claude-agent)) is shown inline in [`middleware/README.md`](middleware/README.md).

## Incident scenarios (runnable)

Twenty real incidents where an AI or automated system took a consequential action it should not have. Each directory is a self-contained, runnable scenario: its `demo.mjs` configures the roles, skills, grants, and limits, drives a governed agent through the proxy, shows the control denying or gating the action, then verifies the audit chain. Each `README.md` keeps the incident's sources and the mapping.

```bash
node examples/knight-capital-440m-runaway-trading/demo.mjs   # server on :3000, auth disabled or admin key
```

- [`air-canada-chatbot-bereavement-refund-binding`](air-canada-chatbot-bereavement-refund-binding/) — Air Canada was bound by its chatbot's invented refund policy
- [`australia-robodebt-automated-debt-recovery`](australia-robodebt-automated-debt-recovery/) — Robodebt: removing the human from a debt notice
- [`camoleak-github-copilot-chat-source-code-exfiltration`](camoleak-github-copilot-chat-source-code-exfiltration/) — CamoLeak: hidden markdown made Copilot leak private source code
- [`chevrolet-watsonville-1-dollar-tahoe-binding-offer`](chevrolet-watsonville-1-dollar-tahoe-binding-offer/) — The $1 Tahoe: a prompt-injected dealership chatbot tries to bind the business
- [`cigna-pxdx-batch-rubber-stamp-denials`](cigna-pxdx-batch-rubber-stamp-denials/) — 1.2 seconds per denial: Cigna's PxDx rubber-stamp problem
- [`citigroup-444b-fat-finger-overridable-warning`](citigroup-444b-fat-finger-overridable-warning/) — Citigroup's $444B basket: a warning you can dismiss is not a control
- [`claude-code-force-push-destroyed-git-history`](claude-code-force-push-destroyed-git-history/) — Claude Code force-pushed over a private repo and destroyed its history
- [`cursor-agent-wiped-pocketos-database-and-backups`](cursor-agent-wiped-pocketos-database-and-backups/) — A coding agent wiped a database and its backups
- [`dn42-agent-runaway-aws-cloud-bill`](dn42-agent-runaway-aws-cloud-bill/) — The agent that spent $6,500 on AWS to scan a hobbyist network
- [`echoleak-m365-copilot-zero-click-exfiltration`](echoleak-m365-copilot-zero-click-exfiltration/) — EchoLeak: a single email made Copilot exfiltrate your files
- [`everbright-securities-runaway-orders-and-insider-hedge`](everbright-securities-runaway-orders-and-insider-hedge/) — Everbright: a trading glitch, then a cover trade before the public knew
- [`google-antigravity-wiped-entire-drive`](google-antigravity-wiped-entire-drive/) — "Clear the cache" became "delete the drive"
- [`grok-bankrbot-morse-code-wallet-drain`](grok-bankrbot-morse-code-wallet-drain/) — A tweet in Morse code drained an AI crypto wallet
- [`knight-capital-440m-runaway-trading`](knight-capital-440m-runaway-trading/) — Knight Capital: $440M in 45 minutes with no kill switch
- [`mata-v-avianca-fabricated-citations-filed`](mata-v-avianca-fabricated-citations-filed/) — Mata v Avianca: a hallucinated brief reached a federal court
- [`meta-rogue-agent-sev1-data-exposure`](meta-rogue-agent-sev1-data-exposure/) — Meta Sev 1: an agent skipped the approval it was supposed to wait for
- [`mypillow-ai-brief-fake-citations-repeat`](mypillow-ai-brief-fake-citations-repeat/) — The MyPillow brief: 30 fake AI citations, then a repeat offense
- [`oncology-patient-access`](oncology-patient-access/) — Oncology patient access: who signs the enrollment and the appeal
- [`replit-agent-deleted-production-database`](replit-agent-deleted-production-database/) — Replit agent deleted a production database during a code freeze
- [`shadowleak-chatgpt-deep-research-gmail-exfiltration`](shadowleak-chatgpt-deep-research-gmail-exfiltration/) — ShadowLeak: zero-click Gmail exfiltration via the ChatGPT Deep Research agent
- [`unitedhealth-nhpredict-ai-medicare-denials`](unitedhealth-nhpredict-ai-medicare-denials/) — nH Predict: an algorithm denying Medicare care with a 90% reversal rate

The shared helper (`lib/scenario.mjs`) holds the idempotent `ensureRole`/`ensureSkill`/`ensureGrant` setup these scripts share.
