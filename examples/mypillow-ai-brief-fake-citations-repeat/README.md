# The MyPillow Brief: 30 Fake AI Citations, Then a Repeat Offense

In 2025, attorneys for Mike Lindell filed a Denver motion containing about 30
defective citations produced with AI, including citations to nonexistent cases.
In July 2025, Judge Nina Wang fined each attorney 3,000 dollars. In May 2026,
Christopher Kachouroff and his firm were sanctioned again, 5,000 dollars, over
another flawed citation in a later filing. Sources:
[Colorado Sun](https://coloradosun.com/2025/07/07/mike-lindell-attorneys-fined-artificial-intelligence/),
[Law&Crime](https://lawandcrime.com/high-profile/puzzlingly-defiant-judge-sanctions-mike-lindells-lawyers-over-ai-generated-filing-rife-with-cites-to-nonexistent-cases-excoriates-their-troubling-explanation/),
[Colorado Politics](https://www.coloradopolitics.com/2026/05/08/mike-lindells-lawyer-sanctioned-again-over-flawed-case-citations/).
Full analysis: https://makerchecker.ai/insights/mypillow-ai-brief-fake-citations-repeat/.

## The risk

Drafting a brief is reversible. Filing it with the court is not: once a motion is
on the docket, the fabricated citations are in the record, and the sanction
follows the filing. The second filing came after the first sanction, so a gate
that fires once and is then trusted does nothing. The gate has to fire on every
submission, including the next version of the same brief.

## The MakerChecker configuration

Split the work by reversibility. Drafting the brief and running citation
verification are reversible, so the `mypillow-brief-author` role holds those
skills and runs them freely. Submitting to the court is the irreversible step,
modeled as a high-risk skill. The proxy refuses any high-risk skill
categorically: it must run through a governed flow with a preceding approval
gate.

The author role never holds a submission skill. An unbounded "file anything"
skill exists in the catalog and is granted to no role, so a self-issued
instruction to file is refused by deny-by-default. The bounded submission skill
is held only by the supervising-attorney role, and because it is published
high-risk, a direct call through the proxy is refused with
`high_risk_requires_gate`.

Skills (`name@version`, `risk_tier`):

- `mypillow-brief-draft@1`, low. Compose or revise the motion; produces a draft,
  files nothing.
- `mypillow-cite-verify@1`, low. Check each citation against an authority source
  for a draft version.
- `mypillow-court-file-verified@1`, high. Submits a verified draft version to the
  court; high-risk, so it must run through a flow behind an approval gate.
- `mypillow-court-file-open@1`, high. Submits an arbitrary filing; exists in the
  catalog but is **not granted** to any role.

Roles and grants (deny by default; only listed grants exist):

- `mypillow-brief-author`: `mypillow-brief-draft@1`, `mypillow-cite-verify@1`.
  No filing grant: the author cannot submit to the court.
- `mypillow-supervising-attorney`: `mypillow-court-file-verified@1`. High-risk,
  so even this role cannot call it directly on the proxy.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/mypillow-ai-brief-fake-citations-repeat/demo.mjs
```

## What happens

```
proxy session 37c498a9-10ad-43de-be71-a3e278c54ee9 opened

author drafts v1: {"draftVersion":1,"body":"motion v1"}
author verifies v1: {"draftVersion":1,"fabricated":30,"passed":false}
author self-file DENIED (skill_not_granted): skill "mypillow-court-file-open@1" is not granted to the role of agent "mypillow-brief-author-bot"
direct submission DENIED (high_risk_requires_gate): skill "mypillow-court-file-verified@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  310  proxy.session.opened
  311  proxy.check.allowed mypillow-brief-author-bot -> mypillow-brief-draft@1
  312  proxy.result.recorded  -> mypillow-brief-draft@1
  313  proxy.check.allowed mypillow-brief-author-bot -> mypillow-cite-verify@1
  314  proxy.result.recorded  -> mypillow-cite-verify@1
  315  enforcement.blocked mypillow-brief-author-bot -> mypillow-court-file-open@1 [skill_not_granted]
  316  enforcement.blocked mypillow-supervising-attorney-bot -> mypillow-court-file-verified@1 [high_risk_requires_gate]
  317  proxy.session.closed

audit chain: ok=true events=317
```

The author drafts and verifies freely; verification surfaces the 30 fabricated
citations but does not stop the draft from existing. The self-file attempt is
refused by deny-by-default before it reaches a tool body, and the direct
submission is refused because the skill is high-risk. Every attempt — allowed,
deny-by-default, and gate-required — is written to the hash-chained,
Ed25519-signed audit log.

## What this does not prevent

It does not stop the AI tool from producing fabricated citations. MakerChecker
constrains and records the filing action, not the content of the draft. The
proxy demonstrates two enforcement primitives — filing is ungranted to the
author, and submission is categorically gated as high-risk. The actual human
sign-off, the per-version re-triggering, and the `forbid_requester` identity
check live in the governed flow that wraps the high-risk step. A supervising
attorney who signs off in that flow without reading the verification record can
still put a brief with bad citations on the docket. What the proxy guarantees is
narrower: filing cannot happen on an agent's own authority, every submission is
forced to a human gate, and who attempted what is recorded.
