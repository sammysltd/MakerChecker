# Nine Seconds Over a Scoped Token Let a Coding Agent Wipe a DB and Backups

On 25 April 2026 a Cursor agent working on a PocketOS staging task found a root
Railway token that was scoped for domain work but carried blanket rights. A single
`volumeDelete` destroyed the production database and the co-located backups in about
nine seconds. The outage ran roughly 30 hours. Sources:
[The Register](https://www.theregister.com/2026/04/27/cursoropus_agent_snuffs_out_pocketos/),
[Hackread](https://hackread.com/cursor-ai-agent-wipes-pocketos-database-backups/),
[Cybersecurity News](https://cybersecuritynews.com/ai-coding-agent-deletes-data/).
Full analysis: https://makerchecker.ai/insights/cursor-agent-wiped-pocketos-database-and-backups/.

## The risk

The platform treated the credential as proof of authority. One call deleted the
production volume and its backups, irreversibly, with no checkpoint between the
model's decision and the destruction of the data.

## The MakerChecker configuration

MakerChecker authorizes the action, not the credential. The
`pocketos-staging-deploy-role` is granted only the safe, reversible skills it needs
and holds no deletion grant. Three layers fire:

- **Deny by default.** Irreversible deletion is a separate skill,
  `pocketos-infra-volume-delete@1`, that the staging role does not hold. The attempt
  is refused with `skill_not_granted` while the agent is still holding the token.
- **High-risk needs a gate.** Deletion is published `riskTier: high`. The
  `pocketos-infra-owner-role` does hold the grant, but the proxy refuses any
  high-risk skill categorically (`high_risk_requires_gate`): it must run inside a
  governed flow behind an approval gate.
- **Argument-scoped variant.** The dangerous variant is modeled as its own skill,
  `pocketos-staging-volume-delete@1`, carrying a `pathScope` limit that confines it
  to `/env/staging`. A staging path is allowed; a production path is refused with
  `limit_path`, fail closed.

Skills, with versions and risk tiers:

- `pocketos-infra-read@1`, low. List services, volumes, and deploy state.
- `pocketos-db-snapshot@1`, low. Take a backup snapshot; the safe direction, runs pre-gate.
- `pocketos-infra-volume-delete@1`, high. Permanently delete a volume and its backups. Not granted to the staging role.
- `pocketos-staging-volume-delete@1`, low, path-scoped to `/env/staging`. The scoped deletion variant.

Roles and grants, deny by default:

```text
role: pocketos-staging-deploy-role
  limits:
    pocketos-infra-read@1:            { maxInvocationsPerRun: 20 }
    pocketos-staging-volume-delete@1: { pathScope: { field: volumePath, prefix: /env/staging } }
  grants:
    - pocketos-infra-read@1
    - pocketos-db-snapshot@1
    - pocketos-staging-volume-delete@1
  # pocketos-infra-volume-delete@1 is NOT granted. Deny by default refuses it.

role: pocketos-infra-owner-role
  grants:
    - pocketos-infra-volume-delete@1   # only granted where deletion is a real duty
```

Argument-level limits, such as restricting deletion to a named non-production
volume, are not flags on the dangerous skill. They are modeled as the distinct
`pocketos-staging-volume-delete@1` skill whose role limit carries the path scope.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/cursor-agent-wiped-pocketos-database-and-backups/demo.mjs
```

## What happens

```
proxy session d3943189-540f-4e2b-a341-7e137be9abd1 opened

agent inspects env: {"services":["api","db"],"target":"staging"}
agent snapshots db: {"snapshot":"staging-db","status":"captured"}
production wipe DENIED (skill_not_granted): skill "pocketos-infra-volume-delete@1" is not granted to the role of agent "pocketos-staging-bot"
owner wipe DENIED (high_risk_requires_gate): skill "pocketos-infra-volume-delete@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate
scoped delete (staging): {"deleted":"/env/staging/scratch","status":"removed"}
scoped delete (production) DENIED (limit_path): skill "pocketos-staging-volume-delete@1" path "/env/production/db" for "volumePath" is outside the allowed prefix "/env/staging" — denied

audit trail:
  124  proxy.session.opened
  125  proxy.check.allowed pocketos-staging-bot -> pocketos-infra-read@1
  126  proxy.result.recorded  -> pocketos-infra-read@1
  127  proxy.check.allowed pocketos-staging-bot -> pocketos-db-snapshot@1
  128  proxy.result.recorded  -> pocketos-db-snapshot@1
  129  enforcement.blocked pocketos-staging-bot -> pocketos-infra-volume-delete@1 [skill_not_granted]
  130  enforcement.blocked pocketos-infra-owner-bot -> pocketos-infra-volume-delete@1 [high_risk_requires_gate]
  131  proxy.check.allowed pocketos-staging-bot -> pocketos-staging-volume-delete@1
  132  proxy.result.recorded  -> pocketos-staging-volume-delete@1
  133  enforcement.limit_violation pocketos-staging-bot -> pocketos-staging-volume-delete@1 [limit_path]
  134  proxy.session.closed

audit chain: ok=true events=134
```

The production wipe is the actual PocketOS call, refused by deny-by-default before
the over-broad token enters the decision. The owner attempt shows that even where
deletion is a real duty, the high tier forces an approval gate. Every attempt —
allowed, ungranted, high-risk, and out-of-scope — commits to the hash-chained,
Ed25519-signed audit.

## What this does not prevent

This does not stop the model going off task, and it does not fix the over-privileged
token. The credential stays too broad at the Railway layer; MakerChecker makes that
breadth unusable for an action the role was never granted. A deletion path that calls
the platform outside the control plane is outside its reach.
