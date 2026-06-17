# Cold-Chain Disposition

A vaccine/biologic pallet suffers a temperature excursion in transit. A
cold-chain monitor agent pulls the excursion log and the validated stability
limits, identifies the affected lots, and **quarantines them itself**. The
one-way door — release vs destroy, six figures either way — belongs to a named
QA person.

The agent moves toward safety with no gate: a held lot is neither released nor
destroyed, so the cost of being wrong is reversible. It is structurally stopped
at the irreversible decision. `quarantine@1` is low risk and runs pre-gate.
`disposition-act@1` is `risk_tier: high`, so the flow grammar forces an approval
gate before the step that uses it. Publishing the same flow without that gate is
rejected with `high_risk_requires_gate`.

Assessment is rule-based against the product's validated stability limits. The
seeded incident is `LOT-5002` (VaxFlu Quad vaccine, 9,800 units, $235,200 on
shipment VAX-2026-114): a 13-point datalogger trace that peaks at 15.0°C against
an 8.0°C labelled limit and spends about 180 minutes above it, past the
validated 120-minute excursion allowance. That is **beyond** stability, so the
monitor recommends **destroy** and quarantines the lot before the gate.

The same rule set produces the other outcomes: **within** (the trace never
reaches the limit, recommended release) and **borderline** (over the limit but
inside the allowance, recommended escalate), the human-judgment cases QA owns.

## Run it

```bash
docker compose up   # from the repo root; seeds everything on first boot
# First boot prints two keys, each shown once: a DEMO ADMIN API KEY and a
# DEMO OFFICER API KEY. The monitor (admin) runs the assessment; QA (officer)
# owns the release-or-destroy decision.
export H='authorization: Bearer mk_...'         # DEMO ADMIN API KEY (triggers the run)
export OFFICER='authorization: Bearer mk_...'   # DEMO OFFICER API KEY (decides disposition)

curl -X POST localhost:3000/api/flows/cold-chain-disposition/runs -H "$H" -H 'content-type: application/json' -d '{}'
curl localhost:3000/api/runs/<runId> -H "$H"   # see LOT-5002 already HELD pre-gate
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$OFFICER" \
  -H 'content-type: application/json' -d '{"decision":"approved","reason":"Destroy LOT-5002: 15C peak vs 8C limit, ~180 min over the 120 min allowance"}'
curl localhost:3000/api/audit/verify -H "$H"
```

The gate is identity-mode (`forbid_requester`): the monitor who assessed the
excursion gets a 403 deciding it (the SoD control firing), and unauthenticated
decisions are refused (fail closed). The DEMO OFFICER API KEY is the eligible QA
approver, a different user than the one that triggered.
