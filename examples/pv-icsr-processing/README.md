# PV ICSR Processing

Pharmacovigilance runs on expedited clocks. 21 CFR 314.80 requires 15-day
expedited ICSRs ("Alert reports") for serious, unexpected adverse experiences,
transmitted in ICH E2B(R3) format. A late expedited report is a per-case,
dated, inspectable failure. Draft EU GMP Annex 22 (published July 7, 2025)
permits generative AI in non-critical tasks only with a qualified human
reviewing the output. AI drafts, a named human signs — this flow's
architecture.

A case-processor agent intakes the day's adverse-event cases and proposes
seriousness/expectedness per case. The run parks at the "medical review" gate
for the medical reviewer, and only then are the ICSR narratives drafted and
delivered. The SoD constraint enforces 21 CFR 211.22 independence — the quality
unit reviewing a case may not be the unit that produced it — so the processor
who triages a case may not perform its medical review. Blocked at runtime.

Triage is rule-based: serious AND unexpected goes onto the 15-day expedited
clock; everything else routes to periodic reporting. The data plants two
expedited cases among ten:

- `P-4003` (Cardevol 10mg): acute liver failure, serious and unexpected — a
  15-day expedited report under 21 CFR 314.80.
- `P-4009` (Gastrelin 40mg): anaphylactic reaction, serious and unexpected,
  received from a foreign source (DE) — also 15-day. The expedited clock is
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
gets a 403 deciding it, and unauthenticated decisions are refused (fail
closed). Approve with a key belonging to a different user than the one that
triggered.

Export the signed, offline-verifiable evidence for the run — every agent
action, grant state, and the reviewer's recorded decision, verifiable with no
system access:

```bash
docker compose exec server node dist/cli.js audit export --run <runId> --out icsr-evidence.json
```
