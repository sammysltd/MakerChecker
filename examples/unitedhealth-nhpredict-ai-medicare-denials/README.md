# nH Predict: An Algorithm Denying Medicare Care With a 90 Percent Reversal Rate

A class action filed around November 2023 in Minnesota alleges that UnitedHealth
and NaviHealth used a model called nH Predict to override treating physicians and
deny post-acute care to Medicare Advantage members, at a roughly 90 percent error
rate, relying on the fact that only about 0.2 percent of members appealed. Across
2025 to 2026 the court let breach-of-contract claims proceed and ordered broad
discovery into the model and how its outputs were used. Sources:
[CBS News](https://www.cbsnews.com/news/unitedhealth-lawsuit-ai-deny-claims-medicare-advantage-health-insurance-denials/),
[Healthcare Finance News](https://www.healthcarefinancenews.com/news/class-action-lawsuit-against-unitedhealths-ai-claim-denials-advances),
[ArentFox Schiff alert](https://www.afslaw.com/perspectives/alerts/federal-court-orders-broad-discovery-against-uhc-ai-coverage-denial-lawsuit).
Full analysis: https://makerchecker.ai/insights/unitedhealth-nhpredict-ai-medicare-denials/.

## The risk

A coverage-decision system commits a denial of post-acute care, terminating the
member's benefit, with no named clinician signing the decision and no record of
who approved it or on what basis. Nothing separates the system that proposes a
denial from the act of finalizing it, and a committed denial stands as final
unless the member appeals.

## The MakerChecker configuration

The action is split by reversibility. Producing a recommendation and assembling
the case file are reversible, so the `uhc-coverage-assessor` role is granted
`uhc-coverage-assess@1` and `uhc-case-file-build@1` only. It holds **no commit
grant**, so an attempt to finalize a denial is refused by deny-by-default before
it reaches a tool body.

Committing the denial is irreversible, so `uhc-coverage-deny-commit@1` is
published at `riskTier: high` and refused on the proxy. It runs only through a
governed flow with a preceding approval gate, where a named clinician signs each
denial before it executes. The `uhc-clinician-reviewer` role holds the commit
grant, but cannot commit through the bare proxy either.

Skills:

- `uhc-coverage-assess@1`, `riskTier: low` (evaluate the request and produce a
  recommendation; commits nothing)
- `uhc-case-file-build@1`, `riskTier: low` (assemble the clinical record and the
  basis for the recommendation)
- `uhc-coverage-deny-commit@1`, `riskTier: high` (finalizes a denial against the
  member's benefit; **not granted** to the assessing role, and refused outside a
  gated flow)

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/unitedhealth-nhpredict-ai-medicare-denials/demo.mjs
```

## What happens

```
proxy session ab705a05-e337-47d7-bcd3-6433661b4653 opened

assessor evaluates: {"member":"M-4471","recommendation":"deny","reversalRateClass":"high"}
assessor builds case file: {"member":"M-4471","caseFile":"assembled"}
assessor commit DENIED (skill_not_granted): skill "uhc-coverage-deny-commit@1" is not granted to the role of agent "uhc-assessor-bot"
reviewer commit DENIED (high_risk_requires_gate): skill "uhc-coverage-deny-commit@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  356  proxy.session.opened
  357  proxy.check.allowed uhc-assessor-bot -> uhc-coverage-assess@1
  358  proxy.result.recorded  -> uhc-coverage-assess@1
  359  proxy.check.allowed uhc-assessor-bot -> uhc-case-file-build@1
  360  proxy.result.recorded  -> uhc-case-file-build@1
  361  enforcement.blocked uhc-assessor-bot -> uhc-coverage-deny-commit@1 [skill_not_granted]
  362  enforcement.blocked uhc-reviewer-bot -> uhc-coverage-deny-commit@1 [high_risk_requires_gate]
  363  proxy.session.closed

audit chain: ok=true events=363
```

The assessor recommends and builds the case file pre-gate because both skills are
reversible and granted. Its attempt to finalize the denial is refused by
deny-by-default; the high-risk commit is refused on the proxy even for the
reviewer that holds the grant. Every attempt commits to the hash-chained,
Ed25519-signed audit — the per-decision record the plaintiffs had to fight
discovery to obtain.

## What this does not prevent

It does not fix the alleged 90 percent error rate. A clinician who signs off on a
wrong denial still causes the harm. MakerChecker forces a named human to commit
each denial and records who approved it on what basis; it does not judge whether
the denial is clinically correct. Accountability, not accuracy.
