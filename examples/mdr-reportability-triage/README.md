# MDR Reportability Triage — the medical-devices demo

In complaint handling, the reportability decision starts a statutory timer the
moment *anyone* becomes aware — 21 CFR 803.50: 30 calendar days for
death/serious-injury/malfunction reports; 803.53: 5 work days where remedial
action is needed. Since February 2, 2026 QMSR is in force: Part 820 now
incorporates ISO 13485, and management reviews plus internal and supplier
audit reports are newly FDA-inspectable. The canonical catastrophe is Philips
Respironics — over 3,700 foam-degradation complaints withheld 2010–2021, a
federal consent decree on April 9, 2024. Under-reporting, not over-reporting,
is what kills companies — and the gap between complaint intake and the
reportability decision is exactly where the liability concentrates.

This flow governs that gap: a complaint analyst agent ingests and triages the
day's complaint queue, the run parks at the "reportability decision" gate for
the regulatory officer, and only then are the MDR report skeletons drafted and
delivered. An SoD constraint binds the two roles: the analyst who triages a
complaint may not decide its reportability. **The agent can never decide
reportability — the regulatory officer does, with evidence an auditor verifies
offline.**

Triage is rule-based — death or serious injury escalates, as does a
malfunction likely to recur. The data plants exactly two escalations among
ten complaints:

- `C-3004` (InsuFlow MX insulin pump): over-delivered insulin overnight,
  patient hospitalized — a serious injury on the 30-calendar-day MDR clock of
  21 CFR 803.50, running from awareness.
- `C-3008` (VentAssist 300 ventilator): low-pressure alarm failed to sound, no
  patient harm this time, recurrence risk high — malfunction-reportable,
  because it would be likely to cause or contribute to a death or serious
  injury if it recurred.

## Run it

```bash
docker compose up   # from the repo root; seeds everything on first boot
export H='authorization: Bearer mk_...'   # admin key printed at first boot

curl -X POST localhost:3000/api/flows/mdr-reportability-triage/runs -H "$H" -H 'content-type: application/json' -d '{}'
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" \
  -H 'content-type: application/json' -d '{"decision":"approved","reason":"C-3004 and C-3008 are reportable; file MDRs within their clocks"}'
curl localhost:3000/api/runs/<runId> -H "$H"
curl localhost:3000/api/audit/verify -H "$H"
```

The gate is identity-mode (`forbid_requester`): the user who triggered the run
gets a 403 deciding it — that 403 is the designated-unit independence control
firing — and unauthenticated decisions are refused outright (fail closed).
Approve with a key belonging to a different user than the one that triggered.

QMSR expanded the inspection surface overnight; the signed, offline-verifiable
evidence export is the inspection-readiness artifact — an investigator
verifies it with no access to your systems:

```bash
docker compose exec server node dist/cli.js audit export --run <runId> --out mdr-evidence.json
```
