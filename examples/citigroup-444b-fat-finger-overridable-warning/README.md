# Citigroup $444B Basket: A Warning You Can Dismiss Is Not a Control

On 2 May 2022 a Citigroup trader meant to sell a $58M basket and instead built
one of $444B. Internal controls blocked $255B, but $189B reached the execution
algorithm and roughly $1.4B sold before the trader cancelled, briefly crashing
the OMX Stockholm 30 by about 8 percent. The trader had dismissed 711 pop-up
warnings on the way to releasing the order. The FCA and PRA fined Citigroup
£61.6M in May 2024. The warnings were overridable; nothing was a hard block.

Sources:
- https://www.cnn.com/2024/05/22/investing/citigroup-fine-stock-dump-fat-finger/index.html
- https://www.bloomberg.com/news/articles/2024-05-22/citigroup-fined-61-6-million-over-fat-finger-trading-blunder
- https://www.marketsmedia.com/citi-fined-61-6m-for-fat-finger-trade/

Full analysis: https://makerchecker.ai/insights/citigroup-444b-fat-finger-overridable-warning/

## The risk

An execution agent submits a basket order whose notional is orders of magnitude
larger than intended. The releasing identity sees warnings but clears them the
same way the trader cleared 711 pop-ups: by clicking through. No notional ceiling
the role cannot exceed on its own, and no second person whose sign-off the order
cannot proceed without.

## The MakerChecker configuration

The action splits by notional, and notional is what the skill grant governs.
Building, pricing, and validating the basket is reversible: a staged order is
neither in the market nor irreversible, so the agent does that pre-gate with no
approval.

- `citi-basket-stage@1` is reversible staging. The `citi-execution-agent` role
  holds it and runs it before any gate to assemble and validate the order.
- `citi-trade-submit-capped@2` is the routine submit path, bounded by a hard
  per-invocation notional ceiling expressed as the role's skill limit
  (`maxAmountPerInvocation` on the `notional` field). Submitting at or below the
  ceiling is allowed; a $444B basket is over the ceiling and is refused outright
  by the proxy with `limit_amount`. No pop-up to dismiss, no override on the
  agent side. The cap is a hard number, not a prompt.
- `citi-trade-submit-uncapped@1` is `risk_tier: high` and the only path that can
  release an over-cap basket. The proxy refuses high-risk skills categorically
  (`high_risk_requires_gate`): even with the grant, the role cannot run it through
  the proxy and must run it in a governed flow behind an approval gate.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/citigroup-444b-fat-finger-overridable-warning/demo.mjs
```

## What happens

```
proxy session c27a1815-4645-4fb9-bb10-fb8d628c7303 opened

stage $58M basket: {"staged":true,"notional":58000000}
submit $58M basket: {"status":"submitted","notional":58000000}
fat-finger $444B submit DENIED (limit_amount): skill "citi-trade-submit-capped@2" amount 444000000000 exceeds the per-invocation limit of 1000000000
over-cap release DENIED (high_risk_requires_gate): skill "citi-trade-submit-uncapped@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  394  proxy.session.opened
  395  proxy.check.allowed citi-execution-bot-v2 -> citi-basket-stage@1
  396  proxy.result.recorded  -> citi-basket-stage@1
  397  proxy.check.allowed citi-execution-bot-v2 -> citi-trade-submit-capped@2
  398  proxy.result.recorded  -> citi-trade-submit-capped@2
  399  enforcement.limit_violation citi-execution-bot-v2 -> citi-trade-submit-capped@2 [limit_amount]
  400  enforcement.blocked citi-execution-bot-v2 -> citi-trade-submit-uncapped@1 [high_risk_requires_gate]
  401  proxy.session.closed

audit chain: ok=true events=401
```

Every attempt — allowed staging, the in-ceiling submit, the over-ceiling
fat-finger, and the over-cap release — commits to the hash-chained,
Ed25519-signed audit log.

## What this does not prevent

This does not stop the wrong number being entered or validate the economics of
the trade. A fat-fingered number is still fat-fingered. What changes is that the
order cannot be released on the agent's own authority once it crosses the ceiling,
and the warning the trader dismissed 711 times becomes a gate requiring another
person's sign-off. The missing hard block is supplied; the typo is not caught.
