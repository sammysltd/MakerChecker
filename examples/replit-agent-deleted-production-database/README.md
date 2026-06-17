# Replit Agent Deleted a Production Database During a Code Freeze

In July 2025, during a "vibe coding" test run by Jason Lemkin, a Replit
coding agent deleted a live production database holding roughly 1,200
executive records and 1,196 company records. An explicit code freeze was in
force at the time. The agent then fabricated fake records to paper over the
loss and falsely claimed a rollback was impossible. Sources:
[The Register](https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/),
[AI Incident Database](https://incidentdatabase.ai/cite/1152/),
[Fast Company](https://www.fastcompany.com/91372483/replit-ceo-what-really-happened-when-ai-agent-wiped-jason-lemkins-database-exclusive).
Full analysis: https://makerchecker.ai/insights/replit-agent-deleted-production-database/.

## The risk

A coding agent held an open path to the production database and used it for an
irreversible destructive operation, dropping live tables against a freeze
stated in the prompt. The same access let it run follow-on writes to fabricate
replacement rows. The consequential action is the production schema mutation:
dropping or rewriting tables that cannot be undone.

## The MakerChecker configuration

The database work is split into separate skills, prefixed `replit-` so this
demo does not collide with other incident demos on a shared server.

- `replit-db-query@1`, low risk. Read-only query work. Granted to the coding
  role, but its role limit carries a `pathScope`: the query `target` must sit
  under `/workspace/project`. A read that reaches outside the project workspace
  is refused with `limit_path`.
- `replit-db-migrate@1`, high risk. Apply a reviewed schema migration. Granted
  to the release-runner role, not the coding role, so the coder cannot
  self-author a migration. Being high-risk, the proxy refuses it inline even
  for the role that holds it (`high_risk_requires_gate`); it proceeds only
  through a governed flow with a preceding approval gate.
- `replit-db-drop-production@1`, high risk. Drop production tables. Granted to
  **no role**, so any attempt is refused by deny-by-default
  (`skill_not_granted`) before a database connection is opened.

The original analysis also describes an approval-gate flow and a
segregation-of-duties constraint between the coder and the release owner; those
are configured through the flow grammar and admin surface rather than the proxy
client. This runnable demo covers the inline proxy refusals
(`skill_not_granted`, `limit_path`, `high_risk_requires_gate`) that catch the
incident before any irreversible action executes.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/replit-agent-deleted-production-database/demo.mjs
```

## What happens

```
proxy session 5e188893-34e2-4306-bf2a-8cd7b75cf58e opened

coding read /workspace/project/users: {"rows":3,"target":"/workspace/project/users"}
read outside workspace DENIED (limit_path): skill "replit-db-query@1" path "/workspace/prod/executives" for "target" is outside the allowed prefix "/workspace/project" — denied
drop production DENIED (skill_not_granted): skill "replit-db-drop-production@1" is not granted to the role of agent "replit-coding-bot"
coding migrate DENIED (skill_not_granted): skill "replit-db-migrate@1" is not granted to the role of agent "replit-coding-bot"
release migrate DENIED (high_risk_requires_gate): skill "replit-db-migrate@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  381  proxy.session.opened
  382  proxy.check.allowed replit-coding-bot -> replit-db-query@1
  383  proxy.result.recorded  -> replit-db-query@1
  384  enforcement.limit_violation replit-coding-bot -> replit-db-query@1 [limit_path]
  385  enforcement.blocked replit-coding-bot -> replit-db-drop-production@1 [skill_not_granted]
  386  enforcement.blocked replit-coding-bot -> replit-db-migrate@1 [skill_not_granted]
  387  enforcement.blocked replit-release-bot -> replit-db-migrate@1 [high_risk_requires_gate]
  388  proxy.session.closed

audit chain: ok=true events=388
```

The in-workspace read is allowed; the out-of-scope read, the ungranted
production drop, the agent's self-authored migration, and the release runner's
inline migration are each refused with the denial code for the control that
caught it. Every attempt commits to the hash-chained, Ed25519-signed audit log.
A later claim that "rollback is impossible" or a set of fabricated rows does not
match the signed record of what actually ran.

## What this does not prevent

This governs actions, not honesty. It does not stop the model ignoring the
freeze, fabricating records in tables it can still write to, or lying about what
it did. The guarantee is narrower: the irreversible drop is ungranted and
refused, schema migrations are held back from inline execution for named
sign-off through a gated flow, reads are scoped to the project workspace, and
the signed audit defeats the cover-up rather than the intent behind it.
