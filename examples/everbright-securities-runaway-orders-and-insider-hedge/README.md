# Everbright: A Trading Glitch, Then a Cover Trade Before the Public Knew

On 16 August 2013 a fault in China Everbright Securities' arbitrage system
generated about 23.4 billion yuan in erroneous buy orders, of which roughly 7.27
billion yuan filled, spiking the Shanghai Composite by about 6 percent. Before
disclosing the error to the market, Everbright hedged its exposure by shorting
ETFs and index futures on the basis of the non-public information. The CSRC fined
the firm 523 million yuan for insider trading and imposed lifetime market bans on
the individuals involved.

Sources:
- https://money.cnn.com/2013/09/02/news/china-everbright-fine/
- https://www.scmp.com/business/banking-finance/article/1300692/china-everbright-securities-fined-523m-yuan-stock-market
- https://www.chinadaily.com.cn/business/2013-08/20/content_16908580.htm

Full analysis: https://makerchecker.ai/insights/everbright-securities-runaway-orders-and-insider-hedge/

## The risk

Two consequential actions, one after the other. An arbitrage agent placed a
stream of live buy orders whose aggregate notional ran orders of magnitude beyond
intent, with no ceiling it could not exceed on its own and no gate between it and
the market. Then the same desk executed large hedging trades on information the
public did not yet have, with nobody independent between the decision to hedge and
its execution.

## The MakerChecker configuration

Three enforcement primitives, checked before any tool body runs.

For the runaway orders, order placement splits by reversibility and the skill
grant governs notional:

- `ebsec-arb-stage@1` assembles and validates the batch. It is reversible, the
  arbitrage role holds the grant, and it runs with no gate.
- `ebsec-arb-submit-capped@1` is granted to the arbitrage role with a role limit:
  `maxAmountPerInvocation` of 1,000,000,000 against the `notional` argument. A
  submit within the cap is allowed; the 23.4 billion yuan stream exceeds it and
  is refused with `limit_amount`. The check fails closed, with no override.
- `ebsec-arb-submit-uncapped@1` is the only path to release an over-cap stream,
  and it is **not granted** to the arbitrage role. The attempt is refused with
  `skill_not_granted` by deny-by-default. In a governed flow that skill sits
  behind an approval gate a named desk head must sign.

For the cover trade, the hedge is the consequential one-way door:

- `ebsec-hedge-draft@1` drafts a proposed hedge. It is reversible, granted, and
  runs pre-gate.
- `ebsec-hedge-submit@1` effects the hedge. It is published `riskTier: "high"`,
  which the proxy refuses categorically with `high_risk_requires_gate`. A
  high-risk action cannot run on the agent's own authority through the proxy; it
  must execute inside a governed flow with a preceding approval gate. The cover
  trade can only travel as a gated request an independent approver releases.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/everbright-securities-runaway-orders-and-insider-hedge/demo.mjs
```

## What happens

```
proxy session 2f45cdaf-618f-4579-80df-c77fa46dc274 opened

arb stages batch: {"staged":true,"notional":500000000}
arb submits 500M yuan: {"status":"submitted","notional":500000000}
runaway 23.4B yuan stream DENIED (limit_amount): skill "ebsec-arb-submit-capped@1" amount 23400000000 exceeds the per-invocation limit of 1000000000
uncapped release DENIED (skill_not_granted): skill "ebsec-arb-submit-uncapped@1" is not granted to the role of agent "ebsec-arbitrage-bot"
hedge drafted: {"drafted":true,"instrument":"index-futures"}
hedge effect DENIED (high_risk_requires_gate): skill "ebsec-hedge-submit@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  198  proxy.session.opened
  199  proxy.check.allowed ebsec-arbitrage-bot -> ebsec-arb-stage@1
  200  proxy.result.recorded  -> ebsec-arb-stage@1
  201  proxy.check.allowed ebsec-arbitrage-bot -> ebsec-arb-submit-capped@1
  202  proxy.result.recorded  -> ebsec-arb-submit-capped@1
  203  enforcement.limit_violation ebsec-arbitrage-bot -> ebsec-arb-submit-capped@1 [limit_amount]
  204  enforcement.blocked ebsec-arbitrage-bot -> ebsec-arb-submit-uncapped@1 [skill_not_granted]
  205  proxy.check.allowed ebsec-hedging-bot -> ebsec-hedge-draft@1
  206  proxy.result.recorded  -> ebsec-hedge-draft@1
  207  enforcement.blocked ebsec-hedging-bot -> ebsec-hedge-submit@1 [high_risk_requires_gate]
  208  proxy.session.closed

audit chain: ok=true events=208
```

The over-cap stream, the ungranted escape hatch, and the high-risk hedge are each
refused with a distinct code, and every attempt is written to the hash-chained,
Ed25519-signed audit log.

## What this does not prevent

It does not fix the software defect that generated the erroneous orders, and it
does not judge whether trading on the undisclosed error is lawful. If an approver
signs off a hedge on material non-public information, the legal question stays
with the humans who decided. What changes: the order stream cannot be released on
the agent's own authority once it crosses the cap, the hedge cannot be effected
through the proxy without a governed flow and an independent approval, and a
record is written either way.
