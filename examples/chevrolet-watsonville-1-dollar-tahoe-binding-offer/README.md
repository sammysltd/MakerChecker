# The 1 Dollar Tahoe: When a Prompt-Injected Chatbot Tries to Bind the Business

On 18 December 2023 the Fullpath ChatGPT-powered chatbot on the Chevrolet of
Watsonville dealer site was prompt-injected by Chris Bakke, who told it to agree
to anything the customer said and to treat its replies as legally binding. The
bot agreed to sell a 2024 Chevrolet Tahoe for 1 dollar and called the offer a
binding agreement. The exchange went viral, the bot was disabled, and no sale
occurred. Sources:
[VentureBeat](https://venturebeat.com/ai/a-chevy-for-1-car-dealer-chatbots-show-perils-of-ai-for-customer-service),
[AI Incident Database](https://incidentdatabase.ai/cite/622/),
[autoevolution](https://www.autoevolution.com/news/someone-convinced-a-chatgpt-powered-chevy-dealer-to-sell-an-81k-tahoe-for-just-1-226451.html).
Full analysis: https://makerchecker.ai/insights/chevrolet-watsonville-1-dollar-tahoe-binding-offer/.

## The risk

The harm here was reputational: the bot emitted text, it could not turn that
text into a contract. The risk to govern is the next one. As dealer and retail
bots get wired into pricing, quoting, and order systems, a customer-facing
assistant that holds a "commit a price" or "create an order" capability lets a
single injected instruction become a binding commitment. Answering a question
about a vehicle is reversible. Committing the business to sell at 1 dollar is
not.

## The MakerChecker configuration

Split the work by reversibility. Answering product and inventory questions and
drafting a quote are reversible, so the `tahoe-sales-info-role` holds those
skills and the chatbot runs them directly. Committing a price is consequential,
so three controls sit between the bot and a binding offer:

- **Deny-by-default on the arbitrary offer.** `tahoe-offer-open@1` commits an
  arbitrary binding price. It exists in the catalog but is granted to no role,
  so the proxy refuses the injected bot's attempt to bind the business with
  `skill_not_granted`.
- **High-risk requires a gate.** `tahoe-offer-bounded@1` is the legitimate price
  commit. It is published `riskTier: high`, so even the sales desk that holds the
  grant cannot run it on the proxy — the proxy refuses with
  `high_risk_requires_gate`. A binding price runs through a governed flow with a
  preceding approval gate.
- **A discount cap that fails closed.** The quote the bot _can_ draft,
  `tahoe-quote-draft@1`, carries a per-invocation `maxAmountPerInvocation` on its
  `discount` argument (here $8,000 against an $81,000 list price). A $1 Tahoe is
  an $80,999 discount, so the proxy refuses the draft with `limit_amount` before
  any tool body runs.

Skills (`name@version`, `risk_tier`):

- `tahoe-vehicle-lookup@1`, `low`. Read inventory, specs, and list prices.
- `tahoe-quote-draft@1`, `low`. Draft a discount-capped quote; commits nothing.
- `tahoe-offer-bounded@1`, `high`. The legitimate bounded price commit; must run
  behind an approval gate, so it is refused on the proxy.
- `tahoe-offer-open@1`, `high`. An arbitrary binding price; granted to no role.

Roles and grants (deny by default; only listed grants exist):

```text
roles:
  tahoe-sales-info-role:  "Answers questions, drafts discount-capped quotes; commits nothing"
  tahoe-sales-desk-role:  "Commits approved bounded prices through a governed flow"

grants:                              # role -> skill@version
  - tahoe-sales-info-role:  tahoe-vehicle-lookup@1
  - tahoe-sales-info-role:  tahoe-quote-draft@1   (limit: discount <= 8000)
  - tahoe-sales-desk-role:  tahoe-offer-bounded@1
  # tahoe-offer-open@1 is granted to no role.
```

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/chevrolet-watsonville-1-dollar-tahoe-binding-offer/demo.mjs
```

## What happens

```
proxy session cc59bbf1-16cf-40b4-8686-4a619512e322 opened

bot looks up the vehicle: {"model":"2024 Chevrolet Tahoe","listPrice":81000}
bot drafts a $5k-off quote: {"price":76000,"discount":5000}
$1 Tahoe quote DENIED (limit_amount): skill "tahoe-quote-draft@1" amount 80999 exceeds the per-invocation limit of 8000
open binding offer DENIED (skill_not_granted): skill "tahoe-offer-open@1" is not granted to the role of agent "tahoe-sales-bot"
direct bounded commit DENIED (high_risk_requires_gate): skill "tahoe-offer-bounded@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  103  proxy.session.opened
  104  proxy.check.allowed tahoe-sales-bot -> tahoe-vehicle-lookup@1
  105  proxy.result.recorded  -> tahoe-vehicle-lookup@1
  106  proxy.check.allowed tahoe-sales-bot -> tahoe-quote-draft@1
  107  proxy.result.recorded  -> tahoe-quote-draft@1
  108  enforcement.limit_violation tahoe-sales-bot -> tahoe-quote-draft@1 [limit_amount]
  109  enforcement.blocked tahoe-sales-bot -> tahoe-offer-open@1 [skill_not_granted]
  110  enforcement.blocked tahoe-sales-desk-bot -> tahoe-offer-bounded@1 [high_risk_requires_gate]
  111  proxy.session.closed

audit chain: ok=true events=111
```

The bot can answer and draft a quote, and it may still emit "1 dollar" as text.
But the $1 quote is over the discount cap, the arbitrary binding offer is
ungranted, and the bounded commit is high-risk and held for a governed flow.
Every attempt — allowed, over-cap, deny-by-default, and high-risk — is written
to the audit chain.

## What this does not prevent

It does not prevent the injection or stop the model emitting text, including the
words "1 dollar" or "this is binding." It removes the authority to turn that text
into a binding action: the arbitrary offer is ungranted, the bounded offer is
discount-capped and held behind a gate, and a price commitment cannot be
self-cleared inside a chat turn. It governs the action, not what the model says.
