# Gross-to-Net Margin

A pharma/medtech company cannot see its true net margin per market or SKU. Each
market hides a different cascade of mandatory rebates, austerity discounts, and
clawbacks, scattered across ERP exports that never reconcile. The rebate accrual
that bridges gross to net is a controlled estimate that enters the financials,
so the gap between list and net is where revenue is overstated and where SOX
exposure concentrates.

## The flow

A market-analyst agent extracts the ERP pricing export, assembles the
gross-to-net waterfall per SKU
(`net = list * (1 - statutory - austerity - clawback)`), normalizes every market
into one comparable margin view, then parks at the "margin certification" gate
for a finance controller. The rebate-accrual summary is drafted and delivered
only after certification. An SoD constraint binds the two roles: the analyst who
builds the margin view may not certify the accrual that enters the financials.

Two human decisions sit on this flow. The consolidation is a single cross-market
margin truth no list-price report shows. The accrual is SOX-controlled: a named
controller certifies it before any figure books.

The waterfall plants one data-integrity anomaly among twelve rows:

- `DE / PUMP-MX` (InsuFlow MX pump): a double-counted austerity discount pushes
  total deductions to 122% of list, producing an impossible negative net of
  **-748.00**. The agent flags it as a `data_integrity_exception` and excludes
  it from the comparable view.

This is not a pricing engine. It does not set prices, negotiate rebates, or
model contracts. It governs the agents that gather, normalize, and certify, with
deny-by-default skills, SoD, and a hash-chained audit trail an auditor verifies
offline.

## Run it

```bash
docker compose up   # from the repo root; seeds everything on first boot
export H='authorization: Bearer mk_...'   # admin key printed at first boot

curl -X POST localhost:3000/api/flows/gross-to-net-margin/runs -H "$H" -H 'content-type: application/json' -d '{}'
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" \
  -H 'content-type: application/json' -d '{"decision":"approved","reason":"Comparable view certified; DE/PUMP-MX excluded pending ERP correction"}'
curl localhost:3000/api/runs/<runId> -H "$H"
curl localhost:3000/api/audit/verify -H "$H"
```

The gate is identity-mode (`forbid_requester`): the analyst who built the view
gets a 403 deciding it, and unauthenticated decisions are refused outright (fail
closed). Certify with a key belonging to a different user than the one that
triggered.

The signed evidence export is the SOX walkthrough artifact — a controller's
certification and the data-integrity exception it acted on, verifiable offline
with no access to your systems:

```bash
docker compose exec server node dist/cli.js audit export --run <runId> --out gtn-evidence.json
```
