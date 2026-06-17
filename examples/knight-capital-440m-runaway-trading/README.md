# Knight Capital: $440M in 45 Minutes With No Kill Switch

On 1 August 2012 Knight Capital deployed new order-routing software to seven of
its eight production servers. The eighth still ran a dormant feature called Power
Peg, which a reused configuration flag reactivated. Over roughly 45 minutes the
eighth server fired millions of unintended orders into the market, producing a
loss of about $440 million. The SEC found that Knight had violated Rule 15c3-5,
the Market Access Rule, and imposed a $12 million penalty. Sources:
[SEC press release](https://www.sec.gov/newsroom/press-releases/2013-222),
[SEC order](https://www.sec.gov/Archives/edgar/data/0001060749/000119312512338098/d392396dex991.htm),
[WilmerHale client alert](https://www.wilmerhale.com/en/insights/client-alerts/knight-capital-settles-rule-15c3-5-violations-with-sec-agrees-to-pay-12-million).

Knight was deterministic software, not an LLM. The control shape is the one a
rogue agent presents: an irreversible action stream with no human gate, no
version pinning, and no ceiling on what a single actor can do.

## The risk

A routing role places live orders against the market. Two failures compounded:
order placement ran with no approval gate and no notional ceiling, and there was
no kill switch between the actor and the market once the stream began.

## The MakerChecker configuration

Order placement is split by reversibility. Building and validating a batch is
reversible, so the `order-router` role is granted `order-build@1` and
`order-validate@1` only. It holds **no send grant**, so an attempt to place an
order is refused by deny-by-default — the order never reaches a tool body.

Sending is governed by the `order-sender` role, whose grant on `order-send@1`
carries enforced limits: a `maxAmountPerInvocation` notional ceiling and a
`maxInvocationsPerRun` cap. Both are checked at the proxy before every call and
fail closed, so a fat-finger order above the ceiling and a runaway stream past
the cap are both refused — the kill switch the incident lacked.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/knight-capital-440m-runaway-trading/demo.mjs
```

## What happens

```
router builds a batch: {"batch":"ACME","lots":10}
router send DENIED (skill_not_granted): skill "order-send@1" is not granted ...
sender order $500k: {"status":"sent","notional":500000}
sender order $600k: {"status":"sent","notional":600000}
runaway $50M order DENIED (limit_amount): amount 50000000 exceeds the per-invocation limit of 1000000
sender order $700k: {"status":"sent","notional":700000}
order past the cap DENIED (limit_invocations): skill "order-send@1" has reached its invocation limit (3)
audit chain: ok=true events=24
```

Every attempt — allowed, deny-by-default, over-ceiling, and past-the-cap — is
written to the hash-chained, Ed25519-signed audit log.

## What this does not prevent

MakerChecker is not a trading risk engine or a CI/CD verifier. It does not detect
a deployment mismatch between servers or dead code left on a host. It governs the
actions an agent takes through granted skills; an order path that calls the market
outside the control plane is outside its reach.
