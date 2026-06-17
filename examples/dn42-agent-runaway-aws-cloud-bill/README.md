# The Agent That Spent $6,500 on AWS to Scan a Hobbyist Network

Between 9 and 10 May 2026 an AI agent told to scan the DN42 hobbyist network
provisioned five AWS `m8g.12xlarge` instances along with load balancers and
Lambda functions, then redeployed duplicates of the same resources in a loop. It
ran up a verified bill of $6,531.30 in about 24 hours. The operator had told it
to continue without reviewing each step.

Sources:
- https://lantian.pub/en/article/fun/ai-agent-bankrupted-their-operator-scan-dn42lantian.lantian/
- https://www.bovo-digital.tech/en/blog/ai-agent-aws-bill-6531-dn42-bankrupt
- https://decrypt.co/370988/ai-agent-rekts-dev-bogus-scan-crypto-donations

Full analysis: https://makerchecker.ai/insights/dn42-agent-runaway-aws-cloud-bill/

## The risk

The consequential action is provisioning paid cloud infrastructure on the
agent's own authority, repeated without a checkpoint. A scan task needed a small
amount of compute. The agent provisioned five large instances plus load
balancers and Lambda, then redeployed duplicates because nothing stopped the
loop. Each provision call was a real spend with no per-action ceiling and no
required second sign-off. The operator's blanket "continue" authorized every
iteration.

## The MakerChecker configuration

The action splits by reversibility and by tier. Inspecting the environment and
tearing resources down are the safe directions, so the scan role runs them
pre-gate with no approval. Provisioning paid compute is the one-way door for the
bill, split into two skills by size: instance class and count are argument-level
bounds expressed as separate skills, not flags on one call.

- `dn42-cloud-inspect@1` is `riskTier: low`. The `dn42-scan-agent` role holds it
  and runs it pre-gate to list resources, regions, and current spend. The role
  caps it at `maxInvocationsPerRun: 20`.
- `dn42-cloud-teardown@1` is `riskTier: low`. It releases resources the agent
  created, the reversible direction toward zero cost, and runs pre-gate.
- `dn42-cloud-provision-small@1` is `riskTier: high` and granted to the scan
  role. Being high-risk, the proxy refuses it categorically: it must travel
  through a governed flow with a preceding per-deploy approval gate
  (`high_risk_requires_gate`).
- `dn42-cloud-provision-large@1` is `riskTier: high` and is **not granted** to
  the scan role at all — only to `dn42-infra-owner`, where large provisioning is
  a real duty. Five large instances can only travel as this skill, which
  deny-by-default refuses (`skill_not_granted`).

The tier is the argument bound. Five large instances is not a bigger version of
a call the role can stretch to cover; it is a call to
`dn42-cloud-provision-large@1`, which the role does not hold. The within-tier
deploy routes to an approval gate, so the redeploy loop meets a fresh sign-off
every iteration instead of running on a single blanket "continue."

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
MAKERCHECKER_URL=http://localhost:3000 node examples/dn42-agent-runaway-aws-cloud-bill/demo.mjs
```

## What happens

```
proxy session 240bdbc6-e6ce-464d-bf63-3c9471fc8a8a opened

agent inspects account: {"region":"eu-central-1","monthlySpendUsd":12.4}
5x m8g.12xlarge DENIED (skill_not_granted): skill "dn42-cloud-provision-large@1" is not granted to the role of agent "dn42-scan-bot"
small deploy DENIED (high_risk_requires_gate): skill "dn42-cloud-provision-small@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate
agent tears down: {"released":"i-0abc"}

audit trail:
  177  proxy.session.opened
  178  proxy.check.allowed dn42-scan-bot -> dn42-cloud-inspect@1
  179  proxy.result.recorded  -> dn42-cloud-inspect@1
  180  enforcement.blocked dn42-scan-bot -> dn42-cloud-provision-large@1 [skill_not_granted]
  181  enforcement.blocked dn42-scan-bot -> dn42-cloud-provision-small@1 [high_risk_requires_gate]
  182  proxy.check.allowed dn42-scan-bot -> dn42-cloud-teardown@1
  183  proxy.result.recorded  -> dn42-cloud-teardown@1
  184  proxy.session.closed

audit chain: ok=true events=184
```

Inspection and teardown run pre-gate. The over-tier batch is refused by
deny-by-default before any resource is created. The within-tier deploy is
refused on the proxy because it must clear an approval gate first. Every attempt
is written to the hash-chained, Ed25519-signed audit log. That record is what a
cost dispute with the provider would rest on.

## What this does not prevent

This is not a billing meter or a hard dollar cap. It does not count spend or stop
the agent once a budget number is hit. A blanket "continue" still authorizes
whatever the role is granted, so the defense is the per-action tier split and the
per-deploy gate, not the standing instruction. If a within-tier deploy is
approved repeatedly through the gate, cost still accrues; what changes is that
over-tier provisioning is refused outright and every paid deploy needs a named
sign-off.
