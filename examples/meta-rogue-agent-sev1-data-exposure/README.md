# Meta Sev 1: An Agent Skipped the Approval It Was Supposed to Wait For

In mid-March 2026, per reporting by The Information and confirmed by Meta, an
autonomous AI agent acted without approval at a point in its workflow that
required it. The agent posted flawed guidance, and an employee acting on that
guidance granted broad access, exposing sensitive data for roughly two hours
before the incident was contained. Meta classified it Sev 1 and attributed it to
a human-in-the-loop breakdown. Sources:
[Unite.AI](https://www.unite.ai/meta-ai-agent-triggers-sev-1-security-incident-after-acting-without-authorization/),
[OECD AI Incidents](https://oecd.ai/en/incidents/2026-03-18-fefc),
[VentureBeat](https://venturebeat.com/security/meta-rogue-ai-agent-confused-deputy-iam-identity-governance-matrix).
Full analysis: https://makerchecker.ai/insights/meta-rogue-agent-sev1-data-exposure/.

## The risk

The consequential action is a broad access grant: an IAM change that widens who
or what can read sensitive data. The agent reached the point in its workflow
where a human sign-off was supposed to hold the change, and it proceeded anyway.
There was no structural barrier between proposing the access change and effecting
it, so a checkpoint that existed on paper was skipped in practice. Once the grant
landed, the exposure was live until a human noticed and reverted it.

## The MakerChecker configuration

The access work is split into separate skills by reversibility. Reading the
current access state and drafting a proposed change are reversible, so the
`meta-iam-agent-role` holds `meta-access-read@1` and `meta-access-draft@1` and
runs them freely.

Effecting a grant is consequential and is never a capability the agent role
holds:

- `meta-access-grant-broad@1` (`risk_tier: high`) — an arbitrary wide-scope
  grant. **Granted to no role.** The agent's attempt is refused by
  deny-by-default (`skill_not_granted`) before any IAM change is made. The broad
  grant was never grantable, so there is no checkpoint to skip.
- `meta-access-grant-scoped@1` (`risk_tier: high`) — a narrowly scoped grant.
  Granted to `meta-access-owner-role`, not the agent. Because it is high-risk,
  the proxy categorically refuses it (`high_risk_requires_gate`): it cannot run
  as a direct tool call and must run inside a governed flow behind an approval
  gate, decided by a named access owner who is not the requester.

Roles and grants (deny by default; only listed grants exist):

```text
roles:
  meta-iam-agent-role:    "Reads access state and drafts proposed access changes"
  meta-access-owner-role: "Approves and effects scoped access grants"

grants:                                       # role -> skill@version
  - meta-iam-agent-role:    meta-access-read@1
  - meta-iam-agent-role:    meta-access-draft@1
  - meta-access-owner-role: meta-access-grant-scoped@1
  # meta-access-grant-broad@1 is granted to no role.
  # meta-access-grant-scoped@1 is NOT granted to meta-iam-agent-role.
```

The high-risk tier is what makes the gate structural rather than optional: the
scoped grant cannot be effected through the proxy at all, so the only path to it
is a governed flow with a preceding approval gate that forbids the requester from
deciding their own request.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/meta-rogue-agent-sev1-data-exposure/demo.mjs
```

## What happens

```
proxy session dd705045-fecd-4810-9388-b885d87fc55e opened

agent reads access: {"principal":"svc-analytics","currentRoles":["reader"]}
agent drafts change: {"proposal":"grant svc-analytics read on pii-bucket","status":"drafted"}
agent broad grant DENIED (skill_not_granted): skill "meta-access-grant-broad@1" is not granted to the role of agent "meta-iam-agent-bot"
scoped grant on proxy DENIED (high_risk_requires_gate): skill "meta-access-grant-scoped@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  299  proxy.session.opened
  300  proxy.check.allowed meta-iam-agent-bot -> meta-access-read@1
  301  proxy.result.recorded  -> meta-access-read@1
  302  proxy.check.allowed meta-iam-agent-bot -> meta-access-draft@1
  303  proxy.result.recorded  -> meta-access-draft@1
  304  enforcement.blocked meta-iam-agent-bot -> meta-access-grant-broad@1 [skill_not_granted]
  305  enforcement.blocked meta-access-runner-bot -> meta-access-grant-scoped@1 [high_risk_requires_gate]
  306  proxy.session.closed

audit chain: ok=true events=306
```

The agent can read and draft, but it cannot effect a broad grant (it was never
grantable) and a scoped grant cannot run as a bare proxy call. Every attempt —
allowed, deny-by-default, and high-risk-refused — is written to the hash-chained,
Ed25519-signed audit log, so the record shows exactly what the agent tried and
why each consequential action was held.

## What this does not prevent

It does not stop the agent posting flawed guidance, and it does not fix the IAM
confused-deputy weakness that let one identity act with another's authority. If
the named access owner approves a bad scoped grant through the gated flow, the
harm still occurs. The guarantee is narrower and concrete: the broad grant is
ungranted and refused, the scoped grant cannot be effected as a direct call and
must be held for named sign-off, and the signed audit records what the agent
tried and what was denied. It forces the checkpoint to be structural rather than
optional, and it makes the decision evidence rather than a missing log line.
