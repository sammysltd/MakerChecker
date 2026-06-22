# CRO Cohort Identification — AI Pre-Screens, the Investigator Signs

CRO feasibility and clinical-operations teams pre-screen oncology populations
against tight inclusion/exclusion criteria — line of therapy, biomarker /
mutation status, ECOG performance status, prior treatments, washout period,
disease progression. The criteria live in unstructured notes and the volume is
high, so pre-screening is the obvious place to put an agent. But the act that
matters is not the screening; it is the **eligibility determination** that
advances a patient toward enrollment. Under ICH E6(R2/R3) Good Clinical
Practice, the investigator is responsible for confirming each subject meets the
protocol's eligibility criteria. A wrong inclusion is a protocol deviation, a
data-integrity and patient-safety finding, and a sponsor/inspection liability.
AI drafts the match; a named sub-investigator or principal investigator signs —
this flow's architecture.

## The safe / consequential asymmetry

The cohort-screener agent does the high-volume, low-stakes work itself. It
screens candidate records against the protocol I/E criteria (`cohort-screen`,
low risk) and computes the matched/unmatched criteria per candidate with the
supporting evidence (`criteria-match`, low risk). Both are reversible and
advisory: surfacing a candidate carries no regulatory weight, so the agent never
waits on a human to propose one.

The act that *does* carry weight is gated. `eligibility-attest@1` attests that a
candidate meets the inclusion/exclusion criteria and advances them to screening
— the determination that, under ICH-GCP, is the investigator's to make and sign.
It is published `risk_tier: high`.

Two enforcement primitives close the gap, both checked at the proxy and failing
closed:

- **`skill_not_granted`** — the `cro-cohort-screener` role holds no attest
  grant, so an attempt by the screener to attest eligibility is refused by
  deny-by-default before it reaches a tool body. The agent cannot advance a
  patient on its own.
- **`high_risk_requires_gate`** — the `cro-sub-investigator` role holds the
  attest grant but still cannot run a high-risk skill inline on the proxy. It
  must run through a governed flow with a preceding approval gate. No path
  advances a patient to screening without a named investigator passing the gate.

## Separation of duties

The control enforces **independent investigator review** — the ICH-GCP
requirement that the investigator (or a qualified, delegated sub-investigator)
confirm eligibility before a subject is enrolled. The screening agent that
proposes a match may not be the party that attests it. The gate records, per
determination, the investigator's identity and the evidence the eligibility call
rests on, so an inclusion that later turns out to be a protocol deviation is
attributable to a signed determination rather than to an opaque automated step.

## The skills and their risk tiers

| skill | risk | who holds it | what it does |
| --- | --- | --- | --- |
| `cohort-screen@1` | low | `cro-cohort-screener` | screen a record against the protocol I/E criteria; proposes only |
| `criteria-match@1` | low | `cro-cohort-screener` | compute matched/unmatched criteria with supporting evidence |
| `eligibility-attest@1` | **high** | `cro-sub-investigator` | attest the candidate meets I/E criteria and advance to screening |

## The planted candidates

Screening is rule-based against `trial_criteria.csv`: a candidate is a proposed
match only if it clears every inclusion criterion (INC-1 NSCLC, INC-2 EGFR
mutation, INC-3 ECOG ≤ 1, INC-4 washout ≥ 21 days, INC-5 confirmed RECIST
progression) and trips no exclusion (EXC-1 more than two prior lines, EXC-2 ECOG
≥ 3, EXC-3 washout < 21 days). `candidates.csv` plants ten records:

- `PT-7001` (NSCLC, EGFR, ECOG 1, one prior line, 28-day washout, confirmed
  progression): clears every inclusion and trips no exclusion — the fully
  matched candidate.
- `PT-7005` is the **borderline** case. It matches INC-1 through INC-4 cleanly,
  but its progression note reads *"possible progression, repeat imaging
  pending"* — not a confirmed RECIST 1.1 progression. INC-5 is therefore
  **unresolved**, not failed. This is exactly the judgment call the agent must
  route to the investigator rather than attest itself: an automated "include" on
  an ambiguous note is the protocol deviation the control exists to prevent.

The remaining rows are deliberate near-misses, each tripping one criterion but
not the rest: `PT-7002` (KRAS, wrong biomarker → INC-2), `PT-7004` (three prior
lines → EXC-1), `PT-7006` (14-day washout → EXC-3), `PT-7003` (ECOG 3 with two
prior lines → INC-3 / EXC-2), `PT-7008` (stable disease, no progression →
INC-5). `PT-7010` is a second ambiguous-progression record — borderline, not
includable on the note alone.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/cro-cohort-identification/demo.mjs
```

`MAKERCHECKER_URL` defaults to `http://localhost:3000`; set `MAKERCHECKER_API_KEY`
to the admin key printed at first boot, or leave it unset against a no-auth local
server.

## What happens

```
proxy session 1f9c0b3a-7e21-4f5b-9a02-2d4e6c8a1b33 opened

screener screens fully-matched candidate: {"candidate":"PT-7001","tumorType":"NSCLC","proposal":"all inclusion criteria met, no exclusion tripped"}
screener matches criteria (PT-7001): {"candidate":"PT-7001","matched":["INC-1 tumor_type=NSCLC","INC-2 mutation=EGFR","INC-3 ecog<=1","INC-4 washout>=21d","EXC-1 prior_lines<=2 ok"],"unmatched":[],"evidence":"biomarker report EGFR exon 19 del; ECOG 1 per clinic note 2026-06-02; last therapy +28d"}
screener screens borderline candidate: {"candidate":"PT-7005","tumorType":"NSCLC","proposal":"INC-5 unresolved — ambiguous progression note, route to investigator"}
screener matches criteria (PT-7005): {"candidate":"PT-7005","matched":["INC-1 tumor_type=NSCLC","INC-2 mutation=EGFR","INC-3 ecog<=1","INC-4 washout>=21d"],"unmatched":["INC-5 confirmed_progression UNRESOLVED"],"evidence":"radiology note 2026-06-05: 'possible progression, repeat imaging pending' — not a confirmed RECIST progression"}
screener eligibility attest DENIED (skill_not_granted): skill "cro-eligibility-attest@1" is not granted to the role of agent "cro-screener-bot"
investigator inline attest DENIED (high_risk_requires_gate): skill "cro-eligibility-attest@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  72  proxy.session.opened
  73  proxy.check.allowed cro-screener-bot -> cro-cohort-screen@1
  74  proxy.result.recorded  -> cro-cohort-screen@1
  75  proxy.check.allowed cro-screener-bot -> cro-criteria-match@1
  76  proxy.result.recorded  -> cro-criteria-match@1
  77  proxy.check.allowed cro-screener-bot -> cro-cohort-screen@1
  78  proxy.result.recorded  -> cro-cohort-screen@1
  79  proxy.check.allowed cro-screener-bot -> cro-criteria-match@1
  80  proxy.result.recorded  -> cro-criteria-match@1
  81  enforcement.blocked cro-screener-bot -> cro-eligibility-attest@1 [skill_not_granted]
  82  enforcement.blocked cro-investigator-bot -> cro-eligibility-attest@1 [high_risk_requires_gate]
  83  proxy.session.closed

audit chain: ok=true events=83
```

The screener screens both candidates and computes their criteria matches pre-gate
because all of that work is reversible and granted. Its attempt to attest
PT-7001 eligible is refused by deny-by-default, and even the granted
sub-investigator cannot attest inline because the attest skill is high-risk.
Every attempt — allowed, ungranted, and refused-high-risk — is written to the
audit chain.

## What this does not prevent

It cannot judge whether an eligibility call is *correct*. An investigator can
still sign an inclusion that turns out to be a protocol deviation, and a
borderline progression note can still be read the wrong way. A gate the human
ignores is not, by itself, a control. What changes is narrower: the
determination becomes attributable. Every advance-to-screening carries a signed
record of which investigator attested it and on what evidence, so a protocol
deviation is traceable to a named sign-off rather than lost in an automated step.
