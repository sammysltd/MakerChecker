# Oncology Patient Access: Who Signs the Enrollment and the Appeal

Specialty-pharmacy "hub" teams move patients onto $100k+/yr oncology therapies
when coverage is thin. The work is bureaucratic and high-volume: benefits
investigation, prior authorization, denials and appeals, and stitching funding
across manufacturer copay cards and independent charitable foundations (PAN,
HealthWell, LLS). An AI agent can do most of it. The two acts it must not do
alone are the two that carry legal weight: **submitting** an appeal or prior-auth
to the payer (an attestation of medical necessity) and **enrolling** a patient
into a copay program or charitable foundation.

The hazard is specific. Routing a government-insured patient — Medicare or
Medicaid — into manufacturer copay support is Anti-Kickback Statute and False
Claims Act exposure. An agent that auto-enrolls at scale turns a clerical
shortcut into a federal liability, with no named human attesting that this
patient, on this plan, was eligible for this program. So a named access
specialist or pharmacist signs before any submit or enroll runs.

## The risk

The system that drafts an appeal and assembles a funding stack also files the
appeal and enrolls the patient, with no named clinician attesting eligibility and
no per-patient record of who approved which enrollment on what basis. Nothing
separates proposing a funding stack from committing a patient into a program, and
a wrong enrollment — a Medicare patient in a manufacturer copay card — stands as
billed until someone catches it.

## The mis-enrollment guardrail

Even at the reversible proposal stage, the agent encodes the rule: manufacturer
copay cards are barred for government plans. The `oncology-funding-match@1` skill
routes a Medicare or Medicaid patient to an independent charitable foundation
(PAN) and marks `copayCardEligible: false`; only a commercial patient gets a
manufacturer copay card in the proposed stack. The demo runs the match for both a
commercial patient (`PT-7001`, copay card permitted) and a Medicare patient
(`PT-7004`, copay card excluded). The proposal is correct — but it is still only
a proposal. Nothing is enrolled until the pharmacist signs.

## The MakerChecker configuration

The work splits by reversibility. Verifying benefits, matching a funding stack,
and drafting a medical-necessity appeal are reversible: low-risk skills the
`oncology-hub-access-coordinator` role holds and runs pre-gate. It holds **no
submit or enroll grant**, so an attempt to file the appeal is refused by
deny-by-default before it reaches a tool body.

Submitting the appeal and enrolling the patient are irreversible, so
`oncology-appeal-submit@1` and `oncology-foundation-enroll@1` are published at
`riskTier: high` and refused on the proxy. They run only through a governed flow
with a preceding approval gate, where a named access specialist / pharmacist
signs each attestation before it executes. The
`oncology-access-specialist-pharmacist` role holds both grants but cannot run
either through the bare proxy.

Two enforcement primitives close the gap, both checked at the proxy and failing
closed:

- **`skill_not_granted`** — the coordinator role holds no submit grant, so its
  attempt to file the appeal is refused by deny-by-default before it reaches a
  tool body.
- **`high_risk_requires_gate`** — the access-specialist role holds the submit and
  enroll grants but still cannot run a high-risk skill inline on the proxy. It
  must run through a governed flow with a preceding approval gate. No path submits
  an appeal or enrolls a patient without a named human signing.

Skills:

- `oncology-benefits-verify@1`, `riskTier: low` (run benefits verification and
  identify the denial reason; commits nothing)
- `oncology-funding-match@1`, `riskTier: low` (match an eligible funding stack to
  the plan type; encodes the copay-card-for-government-plans guardrail)
- `oncology-appeal-draft@1`, `riskTier: low` (draft the medical-necessity appeal
  letter; commits nothing)
- `oncology-appeal-submit@1`, `riskTier: high` (attest medical necessity and
  submit the prior-auth / appeal to the payer; **not granted** to the
  coordinator, and refused outside a gated flow)
- `oncology-foundation-enroll@1`, `riskTier: high` (enroll the patient into a
  copay program or charitable foundation; the AKS / FCA exposure point; refused
  outside a gated flow)

Roles and grants:

- `oncology-hub-access-coordinator` — granted `oncology-benefits-verify@1`,
  `oncology-funding-match@1`, `oncology-appeal-draft@1`. No submit/enroll grant.
- `oncology-access-specialist-pharmacist` — granted `oncology-appeal-submit@1`
  and `oncology-foundation-enroll@1`. The named signer, but only at a gate.

## The mock data

The demo logic runs on inline mock objects; the CSVs beside this README are
illustrative data for the prose:

- `denials.csv` — ten patient denials across commercial, medicare, medicaid, and
  uninsured plan types (`patient_id, diagnosis, drug, plan_type, annual_cost_usd,
  denial_reason`). `PT-7004` (melanoma, Opdivo, **medicare**) is the planted
  case the guardrail must catch: it must never be auto-enrolled into manufacturer
  copay support.
- `funding_sources.csv` — copay cards and charitable foundations with open and
  closed enrollment windows (`source, type, window_status, max_award_usd,
  eligible_plan_types`). `manufacturer_copay` lists `commercial` only;
  `lls_copay` and `good_days` are **closed** windows the match must skip.
- `plan_criteria.csv` — the plan/appeal rules (`criterion_id, plan_type, field,
  rule, description`), including `PC-002` / `PC-003`: manufacturer copay support
  is **prohibited** for Medicare and Medicaid under the Anti-Kickback Statute.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/oncology-patient-access/demo.mjs
```

## What happens

```
proxy session 3f9c1a20-7d44-4e1b-9c6a-2b8e51d0a7f3 opened

coordinator verifies benefits: {"patient":"PT-7001","drug":"Keytruda","planType":"commercial","annualCostUsd":235200,"denialReason":"prior_authorization_required","coverage":"denied"}
coordinator matches funding (commercial): {"patient":"PT-7001","planType":"commercial","proposedStack":["copay_card:manufacturer","charitable_foundation:HealthWell"],"copayCardEligible":true,"note":"commercial plan: copay card permitted"}
coordinator matches funding (medicare): {"patient":"PT-7004","planType":"medicare","proposedStack":["charitable_foundation:PAN"],"copayCardEligible":false,"note":"government plan: manufacturer copay support EXCLUDED (AKS); route to independent foundation only"}
coordinator drafts appeal: {"patient":"PT-7001","drug":"Keytruda","letter":"drafted","basis":"medical necessity per NCCN guideline; prior therapy failed"}
coordinator submit DENIED (skill_not_granted): skill "oncology-appeal-submit@1" is not granted to the role of agent "oncology-hub-access-bot"
specialist submit DENIED (high_risk_requires_gate): skill "oncology-appeal-submit@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate
specialist enroll DENIED (high_risk_requires_gate): skill "oncology-foundation-enroll@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  412  proxy.session.opened
  413  proxy.check.allowed oncology-hub-access-bot -> oncology-benefits-verify@1
  414  proxy.result.recorded  -> oncology-benefits-verify@1
  415  proxy.check.allowed oncology-hub-access-bot -> oncology-funding-match@1
  416  proxy.result.recorded  -> oncology-funding-match@1
  417  proxy.check.allowed oncology-hub-access-bot -> oncology-funding-match@1
  418  proxy.result.recorded  -> oncology-funding-match@1
  419  proxy.check.allowed oncology-hub-access-bot -> oncology-appeal-draft@1
  420  proxy.result.recorded  -> oncology-appeal-draft@1
  421  enforcement.blocked oncology-hub-access-bot -> oncology-appeal-submit@1 [skill_not_granted]
  422  enforcement.blocked oncology-access-specialist-bot -> oncology-appeal-submit@1 [high_risk_requires_gate]
  423  enforcement.blocked oncology-access-specialist-bot -> oncology-foundation-enroll@1 [high_risk_requires_gate]
  424  proxy.session.closed

audit chain: ok=true events=424
```

The coordinator verifies benefits, matches funding, and drafts the appeal
pre-gate because all three skills are reversible and granted — and the Medicare
patient is routed away from manufacturer copay support at the proposal stage. Its
attempt to submit the appeal is refused by deny-by-default; the high-risk submit
and enroll are refused on the proxy even for the access specialist that holds the
grants. Every attempt — allowed, ungranted, and refused-high-risk — is written to
the hash-chained, Ed25519-signed audit chain.

## What this does not prevent

It does not judge whether the appeal will win or whether the funding stack is the
best one. A pharmacist who signs an enrollment the patient was not eligible for
still creates the exposure. MakerChecker forces a named human to attest each
submission and enrollment and records who approved it on what basis; it does not
decide eligibility for them. Accountability, not adjudication.
