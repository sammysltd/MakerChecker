# 1.2 Seconds Per Denial: Cigna's PxDx Rubber-Stamp Problem

A 2023 ProPublica investigation and a California class action revealed that
Cigna used a system called PxDx to deny more than 300,000 requests in two months
in 2022, averaging about 1.2 seconds per decision, with company doctors signing
off on denials in batches without reviewing the individual claims. In March 2025
a court let the class claims proceed.

Sources:
- https://www.cbsnews.com/news/cigna-algorithm-patient-claims-lawsuit/
- https://www.healthcaredive.com/news/cigna-lawsuit-algorithm-claims-denials-california/688857/
- https://www.courthousenews.com/judge-advances-class-claims-over-cigna-use-of-automated-algorithm-to-deny-benefits/

Full analysis: https://makerchecker.ai/insights/cigna-pxdx-batch-rubber-stamp-denials/

## The risk

A claims system can produce a denial and have a reviewer finalize it without the
reviewer reading the claim. The consequential action is the committed denial.
The PxDx pattern was not an ungranted action or a missing gate. A reviewer did
sign each denial. The failure was that sign-off took about 1.2 seconds and ran
in batches, so the human step existed on paper while reviewing nothing. The harm
ran at scale because a committed denial stands unless the member appeals, and
almost none did.

## The MakerChecker configuration

The work splits by reversibility. Producing a recommendation and assembling the
claim file are reversible: low-risk skills the `cigna-claims-assessor` role
holds and runs pre-gate. Committing the denial is the irreversible step, so
`cigna-coverage-deny-commit@1` is published as a **high-risk** skill.

Two enforcement primitives close the gap, both checked at the proxy and failing
closed:

- **`skill_not_granted`** — the assessing role holds no commit grant, so an
  attempt by the assessor to finalize a denial is refused by deny-by-default;
  the denial never reaches a tool body.
- **`high_risk_requires_gate`** — even the `cigna-medical-reviewer` role, which
  does hold the commit grant, cannot run a high-risk skill inline on the proxy.
  It is categorically refused and must run through a governed flow with a
  preceding approval gate. There is no path that finalizes a denial without
  passing the gate.

What the gate then adds is the audit. It records, per decision, the reviewer's
identity and the elapsed time between the claim being presented and the decision
being signed. A batch of denials cleared at sub-second intervals by one reviewer
becomes a visible, attributable pattern in the signed log rather than an
internal metric only the insurer could see.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/cigna-pxdx-batch-rubber-stamp-denials/demo.mjs
```

## What happens

```
proxy session 87c0e072-eaab-41f3-8f5a-cc4430c16175 opened

assessor evaluates claim: {"claim":"C-1001","recommendation":"deny","basis":"not medically necessary"}
assessor builds claim file: {"claim":"C-1001","file":"assembled"}
assessor commit DENIED (skill_not_granted): skill "cigna-coverage-deny-commit@1" is not granted to the role of agent "cigna-assessor-bot"
reviewer inline commit DENIED (high_risk_requires_gate): skill "cigna-coverage-deny-commit@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  64  proxy.session.opened
  65  proxy.check.allowed cigna-assessor-bot -> cigna-coverage-assess@1
  66  proxy.result.recorded  -> cigna-coverage-assess@1
  67  proxy.check.allowed cigna-assessor-bot -> cigna-claim-file-build@1
  68  proxy.result.recorded  -> cigna-claim-file-build@1
  69  enforcement.blocked cigna-assessor-bot -> cigna-coverage-deny-commit@1 [skill_not_granted]
  70  enforcement.blocked cigna-reviewer-bot -> cigna-coverage-deny-commit@1 [high_risk_requires_gate]
  71  proxy.session.closed

audit chain: ok=true events=71
```

The assessor evaluates the claim and builds the file pre-gate because both
skills are reversible and granted. Its attempt to finalize the denial is refused
by deny-by-default, and even the granted reviewer cannot commit inline because
the commit skill is high-risk. Every attempt — allowed, ungranted, and
refused-high-risk — is written to the hash-chained, Ed25519-signed audit log,
so the record shows exactly which denials were committed, by whom, and which
were refused, and why.

## What this does not prevent

It cannot force a reviewer to actually read a claim or judge whether a denial is
correct. A determined reviewer can still click through a gate at speed, and a
denial the reviewer rubber-stamps still commits and still harms the member. A
gate the human ignores is not, by itself, a control. What MakerChecker changes
here is narrower and real: the ignoring becomes provable. Every denial carries a
signed record of who finalized it and how long they spent, so a 1.2-second batch
pattern is attributable rather than deniable.
