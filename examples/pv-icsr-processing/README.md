# PV ICSR Processing — the medicines demo

Pharmacovigilance runs on expedited clocks: 21 CFR 314.80 requires 15-day
expedited ICSRs ("Alert reports") for serious, unexpected adverse experiences,
transmitted in ICH E2B(R3) format. A late expedited report is a per-case,
dated, inspectable failure. And the architecture is becoming law: draft EU GMP
Annex 22 (published July 7, 2025) permits generative AI in non-critical tasks
only with a qualified human reviewing output — if finalized as drafted, **AI
drafts, a named human signs** is the only legal architecture in the EU, which
is this flow's architecture, not an add-on to it.

The flow: a case-processor agent intakes the day's adverse-event cases and
proposes seriousness/expectedness per case, the run parks at the "medical
review" gate for the medical reviewer, and only then are the ICSR narratives
drafted and delivered. The SoD constraint is 211.22-style independence in
software form — 21 CFR 211.22 has mandated an independent quality unit since
before software existed; "the reviewer cannot be the producer" is not a
feature request in pharma, it is 50-year-old law — so the processor who
triages a case may not perform its medical review, blocked at runtime, not
flagged.

Triage is rule-based — serious AND unexpected goes onto the 15-day expedited
clock; everything else routes to periodic reporting. The data plants exactly
two expedited cases among ten:

- `P-4003` (Cardevol 10mg): acute liver failure, serious and unexpected — a
  15-day expedited report under 21 CFR 314.80.
- `P-4009` (Gastrelin 40mg): anaphylactic reaction, serious and unexpected,
  received from a foreign source (DE) — also 15-day: the expedited clock is
  source-independent.

## Run it

```bash
docker compose up   # from the repo root; seeds everything on first boot
export H='authorization: Bearer mk_...'   # admin key printed at first boot

curl -X POST localhost:3000/api/flows/pv-icsr-processing/runs -H "$H" -H 'content-type: application/json' -d '{}'
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" \
  -H 'content-type: application/json' -d '{"decision":"approved","reason":"Seriousness and expectedness confirmed for P-4003 and P-4009"}'
curl localhost:3000/api/runs/<runId> -H "$H"
curl localhost:3000/api/audit/verify -H "$H"
```

The gate is identity-mode (`forbid_requester`): the user who triggered the run
gets a 403 deciding it — the same identity provably cannot be maker and
checker in one run — and unauthenticated decisions are refused outright (fail
closed). Approve with a key belonging to a different user than the one that
triggered.

For the inspector's file, export the signed, offline-verifiable evidence for
the run — every agent action, grant state, and the reviewer's recorded
decision, verifiable with no system access:

```bash
docker compose exec server node dist/cli.js audit export --run <runId> --out icsr-evidence.json
```
