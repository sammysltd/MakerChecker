# Air Canada Was Bound by Its Chatbot's Misstated Refund Policy

In November 2022 Air Canada's website chatbot told Jake Moffatt he could claim a
retroactive bereavement-fare discount within 90 days of booking. Air Canada did
have a bereavement policy, but the real one excluded retroactive claims — the
chatbot misstated it. Moffatt booked on that basis, was later refused the
discount, and took the airline to the BC Civil Resolution Tribunal. In February
2024 the tribunal (2024 BCCRT 149) found negligent misrepresentation and ordered
Air Canada to pay $812.02 CAD ($650.88 in damages plus interest and fees),
rejecting the argument that the chatbot was a separate entity responsible for
its own statements.

Sources:
- https://www.canlii.org/en/bc/bccrt/doc/2024/2024bccrt149/2024bccrt149.html
- https://www.mccarthy.ca/en/insights/blogs/techlex/moffatt-v-air-canada-misrepresentation-ai-chatbot
- https://www.pinsentmasons.com/out-law/news/air-canada-chatbot-case-highlights-ai-liability-risks

Full analysis: https://makerchecker.ai/insights/air-canada-chatbot-bereavement-refund-binding/

## The risk

In the real incident the chatbot only answered a question — it executed
nothing — and the unreviewed answer alone was enough to bind the airline in
law. This demo wires up the adjacent, more dangerous deployment: an assistant
that can also commit refunds. MakerChecker draws the line between the bot
answering and the bot binding the company, and gates only the latter.

## The MakerChecker configuration

Customer-service work is split into separate skills by consequence.

- `aircanada-support-answer@1` (`risk_tier: low`). Answer customer questions and
  quote published policy. Produces text, binds nothing. Granted to the
  `aircanada-support-agent` role, run with no gate.
- `aircanada-refund-commit-capped@1` (`risk_tier: medium`). Effect a refund only
  within published policy and under a fixed threshold. Granted to
  `aircanada-refund-officer` with enforced limits: `maxAmountPerInvocation: 200`
  on `amountCad`, and an `allowlist` on `policyBasis` of
  `[flight-delay, cancellation, baggage]`. Both are checked at the proxy before
  every call and fail closed.
- `aircanada-refund-commit@1` (`risk_tier: high`). Commit a refund of any amount
  or on a non-standard basis. Published high-risk, so the proxy refuses it
  categorically with `high_risk_requires_gate`: it must run through a governed
  flow with a preceding approval gate, decided by a named officer who is not the
  requester.

The support role holds **no commit grant of any kind**, so the bot attempting to
commit the invented refund is refused by deny-by-default before any obligation is
recorded. Argument-level limits matter: a blanket commit grant would let an agent
bind the company to any amount on any invented basis. The capped commitment is a
distinct skill scoped to the threshold and the published-policy set, not a flag
on the answer skill.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/air-canada-chatbot-bereavement-refund-binding/demo.mjs
```

## What happens

```
proxy session 05c3409a-554d-47c6-92b8-22b384c546d0 opened

bot answers: {"reply":"You can claim the bereavement discount retroactively within 90 days."}
bot refund commit DENIED (skill_not_granted): skill "aircanada-refund-commit@1" is not granted to the role of agent "aircanada-support-bot"
officer refunds CAD 150 (cancellation): {"status":"refunded","amountCad":150,"basis":"cancellation"}
invented-basis refund DENIED (limit_allowlist): skill "aircanada-refund-commit-capped@1" value "retroactive-bereavement" for "policyBasis" is not on the allowlist — denied
over-threshold refund DENIED (limit_amount): skill "aircanada-refund-commit-capped@1" amount 812 exceeds the per-invocation limit of 200
open refund commit DENIED (high_risk_requires_gate): skill "aircanada-refund-commit@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  82  proxy.session.opened
  83  proxy.check.allowed aircanada-support-bot -> aircanada-support-answer@1
  84  proxy.result.recorded  -> aircanada-support-answer@1
  85  enforcement.blocked aircanada-support-bot -> aircanada-refund-commit@1 [skill_not_granted]
  86  proxy.check.allowed aircanada-refund-officer-bot -> aircanada-refund-commit-capped@1
  87  proxy.result.recorded  -> aircanada-refund-commit-capped@1
  88  enforcement.limit_violation aircanada-refund-officer-bot -> aircanada-refund-commit-capped@1 [limit_allowlist]
  89  enforcement.limit_violation aircanada-refund-officer-bot -> aircanada-refund-commit-capped@1 [limit_amount]
  90  enforcement.blocked aircanada-refund-officer-bot -> aircanada-refund-commit@1 [high_risk_requires_gate]
  91  proxy.session.closed

audit chain: ok=true events=91
```

The bot answers the customer, fabricated bereavement claim included; that text
binds nothing. When it reaches for a refund commitment, deny-by-default refuses
it before any obligation attaches to the airline. A standard-policy refund within
the threshold and on an allowed basis issues without a gate. An invented basis is
caught by the allowlist, an amount over the threshold by the ceiling, and an
open-amount commit is categorically refused as high-risk. Every attempt is
written to the hash-chained, Ed25519-signed audit log.

## What this does not prevent

This does not stop the chatbot hallucinating a policy or make its answers
correct. Content control is a separate concern. What it prevents is an unreviewed
statement turning into a binding commitment. The threshold-bounded skill still
issues small standard-policy refunds without a gate, so a misconfigured cap or an
in-scope-but-wrong refund inside the threshold would not be held.
