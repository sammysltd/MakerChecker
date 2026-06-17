# Mata v Avianca: A Hallucinated Brief Reached a Federal Court

In 2023, attorneys filed a brief in the Southern District of New York that cited
six cases ChatGPT had fabricated, then submitted fake excerpts when the citations
were questioned. Judge Castel found bad faith and sanctioned the attorneys and
their firm 5,000 dollars under Rule 11. Sources:
[Mata v. Avianca, Inc. (Wikipedia)](https://en.wikipedia.org/wiki/Mata_v._Avianca,_Inc.),
[Seyfarth analysis](https://www.seyfarth.com/news-insights/update-on-the-chatgpt-case-counsel-who-submitted-fake-cases-are-sanctioned.html),
[court opinion (PDF)](https://www.law.berkeley.edu/wp-content/uploads/archive/2025/12/Mata-v-Avianca-Inc.pdf).
Full analysis: https://makerchecker.ai/insights/mata-v-avianca-fabricated-citations-filed/.

## The risk

A drafting agent produced a brief and the same actor moved it to filing. The
consequential action is the filing: submitting a document to a federal court
docket. That submission is a representation to the court under Rule 11 and cannot
be quietly withdrawn once on the docket. The drafter both wrote the brief and
controlled the path that put it before the judge, with no separate party
accountable for the version filed.

## The MakerChecker configuration

Split the work by reversibility. Drafting and internal citation lookup are
reversible and stay with the drafting role, which can run them before any gate.
Filing to the court docket is irreversible, so it is a high-risk skill the
drafter does not hold.

Two controls catch the incident, both checked at the proxy and both fail closed:

- **Deny-by-default on filing.** The `mata-drafting-attorney` role is granted
  `mata-brief-draft@1` and `mata-citation-lookup@1` only. It holds no filing
  grant, so when the drafting agent attempts `mata-court-file@1` the proxy
  refuses with `skill_not_granted` before anything reaches the docket.
- **High-risk requires a gate.** `mata-court-file@1` is published with
  `riskTier: "high"`. The `mata-supervising-attorney` role holds the grant, but a
  high-risk skill is categorically refused on the proxy with
  `high_risk_requires_gate`. It must execute inside a governed flow with a
  preceding approval gate, where a named approver who is not the requester signs
  off on the exact brief version before the docket is touched.

Skills (`name@version`, `risk_tier`):

- `mata-brief-draft@1`, low. Compose and revise the brief; files nothing.
- `mata-citation-lookup@1`, low. Query the internal case database. Reversible reads.
- `mata-court-file@1`, high. Submit a specific brief version to the docket.

Roles and grants (deny by default; only listed grants exist):

- `mata-drafting-attorney`: `mata-brief-draft@1`, `mata-citation-lookup@1`.
- `mata-supervising-attorney`: `mata-court-file@1`.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/mata-v-avianca-fabricated-citations-filed/demo.mjs
```

## What happens

```
proxy session 72325b16-323c-44ad-9053-b8cc583726a8 opened

drafter writes brief: {"brief":"Mata v. Avianca","version":"v3"}
drafter looks up cites: {"query":"tolling Montreal Convention","hits":6}
drafter file DENIED (skill_not_granted): skill "mata-court-file@1" is not granted to the role of agent "mata-drafting-bot"
supervisor direct file DENIED (high_risk_requires_gate): skill "mata-court-file@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  248  proxy.session.opened
  249  proxy.check.allowed mata-drafting-bot -> mata-brief-draft@1
  250  proxy.result.recorded  -> mata-brief-draft@1
  251  proxy.check.allowed mata-drafting-bot -> mata-citation-lookup@1
  252  proxy.result.recorded  -> mata-citation-lookup@1
  253  enforcement.blocked mata-drafting-bot -> mata-court-file@1 [skill_not_granted]
  254  enforcement.blocked mata-supervising-bot -> mata-court-file@1 [high_risk_requires_gate]
  255  proxy.session.closed

audit chain: ok=true events=255
```

The drafting steps run. The drafter's filing attempt is refused by
deny-by-default, and the supervising attorney's direct filing attempt is refused
because the action is high-risk and must run through a gated flow. Every
attempt — allowed, deny-by-default, and high-risk — commits to the hash-chained,
Ed25519-signed audit log.

## What this does not prevent

This intercepts the filing and makes a named human accountable for the version
that goes out. It does not check the brief: it does not stop the hallucination,
verify that the cited cases exist, or detect the fabricated excerpts. If the
supervising attorney rubber-stamps the gate, the bad filing still reaches the
docket. The guarantee is narrow and concrete: the drafter cannot file its own
work, a high-risk filing cannot run as an ad hoc call outside a gated flow, and
the audit records every attempt and its disposition.
