# Gross-to-Net Margin — the pharma/medtech commercial demo

A pharma/medtech company cannot see its true net margin per market or SKU. The
list price is fiction: every market hides a different cascade of mandatory
rebates, austerity discounts, and clawbacks, scattered across ERP exports that
never reconcile. The gap between list and net is where revenue is overstated —
and where SOX exposure concentrates, because the rebate accrual that bridges
gross to net is a controlled estimate that enters the financials.

This flow governs that gap: a market-analyst agent extracts the ERP pricing
export, assembles the gross-to-net waterfall per SKU
(`net = list * (1 - statutory - austerity - clawback)`), normalizes every
market into one comparable margin view, then parks at the "margin
certification" gate for a finance controller. Only after certification is the
rebate-accrual summary drafted and delivered. An SoD constraint binds the two
roles: **the analyst who builds the margin view may not certify the accrual
that enters the financials.**

The waterfall plants exactly one data-integrity anomaly among twelve rows:

- `DE / PUMP-MX` (InsuFlow MX pump): a double-counted austerity discount pushes
  total deductions to 122% of list, producing an impossible **negative net of
  -748.00**. The agent flags it as a `data_integrity_exception` and excludes it
  from the comparable view — this is precisely the wrong number the org would
  otherwise post to the financials.

Two human decisions sit on this flow. The **consolidation** is the most
commercially explosive document the company produces — a single cross-market
margin truth no list-price report ever shows. The **accrual** is
SOX-controlled: a named controller certifies it before any figure books.

**Honesty note:** this is not a pricing engine. We do not set prices,
negotiate rebates, or model contracts. We govern the agents that gather,
normalize, and certify — with deny-by-default skills, SoD, and a hash-chained
audit trail an auditor verifies offline.

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
gets a 403 deciding it — that 403 is the certification-independence control
firing — and unauthenticated decisions are refused outright (fail closed).
Certify with a key belonging to a different user than the one that triggered.

The signed, offline-verifiable evidence export is the SOX walkthrough artifact
— a controller's certification and the data-integrity exception it acted on,
verifiable with no access to your systems:

```bash
docker compose exec server node dist/cli.js audit export --run <runId> --out gtn-evidence.json
```
