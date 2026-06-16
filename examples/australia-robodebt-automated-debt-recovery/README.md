# Robodebt: Removing the Human From a Debt Notice

From 2015 to 2019 the Australian government's Robodebt scheme used automated
income averaging to raise welfare debts and issue debt notices, removing the
human review that had previously checked each determination so that notices went
out unreviewed. The scheme wrongly accused roughly 400,000 people and unlawfully
recovered about A$1.76 billion. A 2023 Royal Commission found it crude, cruel,
and unlawful.

Sources:
- https://robodebt.royalcommission.gov.au/publications/report
- https://lsj.com.au/articles/crude-cruel-and-unlawful-robodebt-royal-commission-findings/
- https://www.bsg.ox.ac.uk/blog/australias-robodebt-scheme-tragic-case-public-policy-failure

Full analysis: https://makerchecker.ai/insights/australia-robodebt-automated-debt-recovery/

This was deterministic government software, not an LLM. It is included because
the control shape is the one agentic systems reproduce: an automated decision
committed against a person with the human review removed from the path.

## The risk

A determination system calculates a debt from averaged income data and then
issues the debt notice itself. The consequential action is the committed
issuance: a notice that asserts a debt against a named citizen and starts
recovery. Once removed, the human check was no longer a step the determination
had to pass, so a flawed calculation became an issued debt with no named officer
behind it and no per-debt record of who authorised it.

## The MakerChecker configuration

The work splits by reversibility, and the demo enforces that split with two
proxy primitives.

- `robodebt-debt-calculate@1` is `risk_tier: low`. The `robodebt-debt-calculator`
  role holds it and runs it pre-gate to compute the debt and stage the proposed
  notice. A proposed debt is neither issued nor in recovery, so staging needs no
  approval.
- `robodebt-debt-issue@1` is `risk_tier: high`. It commits a notice and starts
  recovery — a one-way door. It is **not granted** to the calculator role at all,
  so the system that produced the figure cannot issue the notice; the attempt is
  refused by deny-by-default (`skill_not_granted`) and never reaches a tool body.
- The `robodebt-notice-issuer` role does hold the issue grant, but because the
  skill is high-risk the proxy refuses it outright (`high_risk_requires_gate`):
  issuance cannot run through the proxy at all. It can only travel through a
  governed flow whose grammar forces an approval gate for a named review officer
  before the issuing step — a different identity than the system that calculated
  the debt.

The combination reinstates the removed human check: a debt can be calculated
freely, but no notice issues without authorisation, and the calculator can never
finalise its own determination.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/australia-robodebt-automated-debt-recovery/demo.mjs
```

## What happens

```
proxy session 6e64e462-ad5c-4a9e-b996-d3c1f6f6368e opened

calculator stages a proposed notice: {"status":"staged","citizen":"AX-4471","proposedDebt":3120.5}
calculator issue DENIED (skill_not_granted): skill "robodebt-debt-issue@1" is not granted to the role of agent "robodebt-calculator-bot"
direct issue DENIED (high_risk_requires_gate): skill "robodebt-debt-issue@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  160  proxy.session.opened
  161  proxy.check.allowed robodebt-calculator-bot -> robodebt-debt-calculate@1
  162  proxy.result.recorded  -> robodebt-debt-calculate@1
  163  enforcement.blocked robodebt-calculator-bot -> robodebt-debt-issue@1 [skill_not_granted]
  164  enforcement.blocked robodebt-issuer-bot -> robodebt-debt-issue@1 [high_risk_requires_gate]
  165  proxy.session.closed

audit chain: ok=true events=165
```

The staged proposal, the deny-by-default refusal, and the high-risk refusal are
all written to the hash-chained, Ed25519-signed audit log, so the record shows
which debts were staged and that no notice issued outside an approval gate.

## What this does not prevent

This does not fix the flawed income-averaging method or settle the legal
question of whether the debts were lawful. If a named officer signs off on a
debt that the averaging got wrong, the notice still issues and the harm still
occurs. Its guarantee is narrower: no notice issues without authorisation, the
calculator cannot finalise its own determination, and every issued debt carries
a signed record of who authorised it, which forces accountability and likely
surfaces the problem earlier than an unreviewed pipeline would.
