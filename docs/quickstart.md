# Quickstart

Two paths: Docker Compose (fastest) or local development. Both end with a governed flow run and a verified audit chain.

## Docker Compose

Requires Docker. From the repo root:

```bash
docker compose up
```

This starts `postgres:17-alpine` and builds/starts the server. The compose file sets `MAKERCHECKER_SEED_DEMO=1` and `DEMO_DATA_DIR` for you (seeding is opt-in by default), so on first boot the server applies migrations, seeds the demos, and prints:

```
[makerchecker] DEMO ADMIN API KEY (shown once - copy it now): mk_<32 hex>
[makerchecker] DEMO OFFICER API KEY (for approving gated decisions): mk_<32 hex>

makerchecker server listening on :3000 (executor: scripted)
```

Copy both keys; each is shown exactly once (only their hashes are stored). The admin key triggers runs and approves the cash-reconciliation gate below; the officer key is the eligible approver for the AML flow's identity-mode gate (the requester cannot approve their own run). The web UI is served at `http://localhost:3000`.

`executor: scripted` means no model API key was found, so agent steps execute deterministically (fully air-gapped). Set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` on the host before `docker compose up` to run agents on a real model (`executor: llm (...)`).

Drive the demo:

```bash
export H='authorization: Bearer mk_...'   # the key printed at boot

curl -X POST localhost:3000/api/flows/daily-cash-reconciliation/runs \
  -H "$H" -H 'content-type: application/json' -d '{}'
# -> {"runId":"..."}

curl localhost:3000/api/approvals -H "$H"
# -> {"approvals":[{"id":"...","step_key":"exception_review",...}]}

curl -X POST localhost:3000/api/approvals/<id>/decision \
  -H "$H" -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"Both exceptions explained"}'
# -> {"ok":true}

curl localhost:3000/api/runs/<runId> -H "$H"     # steps, approvals, audit events
curl localhost:3000/api/audit/verify -H "$H"
# -> {"ok":true,"count":<n>,"headHash":"..."}
```

The demo data contains exactly two planted exceptions (`T-1009` amount mismatch, `T-1012` missing ledger entry); see [the demo README](../examples/daily-cash-reconciliation/README.md), which also covers `self-approval-attempt`, the seeded flow that segregation of duties blocks. The seed also publishes `high-value-payment` (a 2-approver dual-authorization gate) and `aml-alert-triage`, the financial-crime demo that parks at a BSA-officer gate; see [its README](../examples/aml-alert-triage/README.md).

## Local development

Prerequisites: Node 22 (`.nvmrc`), pnpm via corepack, and PostgreSQL 17 **binaries** for the test suite (`brew install postgresql@17` on macOS; tests boot a throwaway cluster, no running server needed, or set `TEST_DATABASE_URL` / `PG_BIN` instead).

```bash
corepack pnpm install
corepack pnpm run ci      # lint + typecheck + test + build (what CI runs)
```

Run the server against a Postgres of your choice:

```bash
corepack pnpm run build
DATABASE_URL=postgres://makerchecker:makerchecker@localhost:5432/makerchecker \
  MAKERCHECKER_SEED_DEMO=1 \
  DEMO_DATA_DIR=examples/daily-cash-reconciliation \
  node packages/server/dist/index.js
```

Migrations run at boot. Demo seeding is **opt-in**: set `MAKERCHECKER_SEED_DEMO=1` to seed the demo agents, flows, and admin account (a default boot seeds nothing). The demo ingest skills read only within the configured `DEMO_DATA_DIR` tree. For the web UI with hot reload, in a second terminal:

```bash
corepack pnpm --filter @makerchecker/web dev   # Vite on :5173, proxies API to :3000
```

`corepack pnpm --filter @makerchecker/server dev` runs the built server under `node --watch`.

## API key auth

All API routes live under `/api` and require `authorization: Bearer mk_...`; `/healthz`, static web assets, and the SPA's own routes stay open. Keys look like `mk_<32 hex>`; the server stores only their SHA-256 hash plus an 8-character prefix for identification. The seeded admin and officer keys are printed once at first boot.

For local demos you can disable auth entirely with `MAKERCHECKER_AUTH_DISABLED=1` on the server. Never do this on a reachable deployment.

## CLI

The CLI ships in the server package (run it from `packages/server` after a build, with `DATABASE_URL` set):

```bash
node dist/cli.js migrate
# applied: 0001_init.sql, 0002_webhooks.sql, ...      (or: up to date)

node dist/cli.js audit verify
# {
#   "ok": true,
#   "count": 42,
#   "headHash": "9f2c..."
# }
# exit code 0 if ok, 1 if the chain fails verification

node dist/cli.js audit export --out bundle.json            # full chain
node dist/cli.js audit export --run <runId> --out run.json # one run
# wrote 42 events to bundle.json

node dist/cli.js audit verify-bundle --in bundle.json      # offline, no database
# { "ok": true, "count": 42, "signingKeyFingerprint": "9f2c..." }
node dist/cli.js audit verify-bundle --in bundle.json --key instance.pub  # pin the expected key
# exit code 0 if ok, 1 if verification fails
```

`audit export` signs the bundle with the instance's Ed25519 key (created on first use under `MAKERCHECKER_DATA_DIR`, default `./data`). `audit verify-bundle` checks a bundle file with **no database connection**, so an auditor or regulator can verify a `bundle.json` you hand them on an air-gapped machine. `--key <pubkey.pem>` pins the expected instance public key (obtained out of band) so a bundle re-signed with a different key is rejected. See [the audit spec](audit-spec.md).

Under compose: `docker compose exec server node dist/cli.js audit verify`.

## Live smoke test (real model)

Proves a real LLM driving a governed step end to end, local skill plus MCP skill, every call audited:

```bash
cd packages/server
DATABASE_URL=postgres://... GEMINI_API_KEY=... node scripts/live-smoke.mjs
# or: ANTHROPIC_API_KEY=... LIVE_PROVIDER=anthropic node scripts/live-smoke.mjs
```

Prints the step output, the audit trail for the run (`llm.call`, `skill.invoked`, token usage), the chain verification result, and `LIVE SMOKE OK`.

## SDK

A thin typed client over the API lives in `packages/sdk`. The end-to-end demo script:

```bash
corepack pnpm run build
MAKERCHECKER_API_KEY=mk_... node examples/sdk-demo.mjs
```

It triggers the reconciliation flow, polls to the gate, approves it, prints the report output, and verifies the audit chain. Source: [examples/sdk-demo.mjs](../examples/sdk-demo.mjs).
