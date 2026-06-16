# AML Alert Triage — the financial-crime demo

Financial-crime operations are the banking workflow where "maker-checker" is
not a metaphor: the Wolfsberg Group's guidance names maker-checker/four-eye
review as the control standard, the SAR filing decision is a mandated human
gate, and NYDFS Part 504 requires an annual personal certification of the
monitoring program. This flow runs that exact shape: an L1 analyst agent
ingests and triages the day's alerts, the run parks at the "SAR filing
decision" gate for the BSA officer, and only then are the SAR narratives
drafted and delivered. An SoD constraint binds the two roles: the analyst who
works an alert may not approve its disposition.

Triage is rule-based — `risk_score >= 80` or a sanctions near-match escalates.
The data plants exactly two escalations among ten alerts:

- `A-2007` (Northgate Vending Inc): repeated just-under-threshold cash
  deposits, risk score 86 — a likely true-positive structuring pattern.
- `A-2005` (Sable Trading FZE): a sanctions near-match, escalated regardless
  of its score.

## Run it

```bash
docker compose up   # from the repo root; seeds everything on first boot
# First boot prints two keys, each shown once: a DEMO ADMIN API KEY and a
# DEMO OFFICER API KEY. The admin triggers the run; the officer approves the gate.
export H='authorization: Bearer mk_...'         # DEMO ADMIN API KEY (triggers the run)
export OFFICER='authorization: Bearer mk_...'   # DEMO OFFICER API KEY (approves the SAR gate)

curl -X POST localhost:3000/api/flows/aml-alert-triage/runs -H "$H" -H 'content-type: application/json' -d '{}'
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$OFFICER" \
  -H 'content-type: application/json' -d '{"decision":"approved","reason":"File SARs for A-2005 and A-2007"}'
curl localhost:3000/api/runs/<runId> -H "$H"
curl localhost:3000/api/audit/verify -H "$H"
```

The gate is identity-mode (`forbid_requester`): the admin who triggered the run
gets a 403 deciding it (that 403 is the four-eye control firing), and
unauthenticated decisions are refused outright (fail closed). The DEMO OFFICER
API KEY is the eligible approver, a different user than the one that triggered.

For the Part 504 certification file, export the signed, offline-verifiable
evidence for the run — no database access required to verify it:

```bash
docker compose exec server node dist/cli.js audit export --run <runId> --out sar-evidence.json
```
