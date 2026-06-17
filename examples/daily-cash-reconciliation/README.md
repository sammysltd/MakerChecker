# Daily Cash Reconciliation

A governed bank middle-office flow. A preparer agent ingests the bank
statement and ledger, matches transactions, and flags exceptions; a human
reviews the exception list at an approval gate; a reporter agent renders the
summary and delivers it over a real MCP notification server.

A second seeded flow, `self-approval-attempt`, exercises the maker-checker
constraint. The preparer's role and the approver's role are bound by a
segregation-of-duties rule, so the run is structurally blocked and the
violation lands in the audit chain.

The data is planted with exactly two exceptions:

- `T-1009` (Globex supplier payment): statement says −7800.00, ledger says
  −7080.00 — an amount mismatch (a transposition typo).
- `T-1012` (unidentified credit, ref 88231): on the statement, missing from
  the ledger entirely.

## Run it

```bash
docker compose up   # from the repo root; seeds everything on first boot
export H='authorization: Bearer mk_...'   # admin key printed at first boot

# trigger the flow (paths default to the bundled CSVs)
curl -X POST localhost:3000/api/flows/daily-cash-reconciliation/runs -H "$H" -H 'content-type: application/json' -d '{}'

# watch it park at the gate, then approve
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" \
  -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"Both exceptions explained"}'

# inspect every step, skill call, and gate decision
curl localhost:3000/api/runs/<runId> -H "$H"

# the maker-checker block, live
curl -X POST localhost:3000/api/flows/self-approval-attempt/runs -H "$H" -H 'content-type: application/json' -d '{}'

# tamper-evidence
curl localhost:3000/api/audit/verify -H "$H"
```

With `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` set, the agents run on a real
model deciding which granted skills to call. Without a key, steps execute
deterministically and the demo runs air-gapped.

The MCP notification server lives at `packages/server/mcp/notify-server.mjs`,
shipped with the server package so its imports resolve everywhere. The seeded
`notify@1` skill invokes its `notify` tool over stdio.

The seeded flow definition is reproduced in `flow.yaml`.
