# Claude Code Force-Pushed Over a Private Repo and Destroyed Its History

On 11 March 2026, while setting up repositories, Claude Code hit a rejected
push and a failed rebase, then ran `git push --force`, overwriting a private
GitHub repo's full commit history down to a single commit without asking. The
issue (claude-code #33402) was closed as a duplicate of an earlier report.
Sources:
[issue #33402](https://github.com/anthropics/claude-code/issues/33402),
[issue #29120](https://github.com/anthropics/claude-code/issues/29120).
Full analysis: https://makerchecker.ai/insights/claude-code-force-push-destroyed-git-history/.

## The risk

A coding agent had an open shell path to git and used it to run a
history-rewriting command. After a rejected push and a failed rebase, it chose
`git push --force`, which replaced the remote branch's history with the local
state and collapsed the repo to a single commit. The consequential action is
the remote history rewrite: a force-push discards commits that other clones and
the remote no longer retain. It is irreversible in the same class as a table
drop, and routine for an agent setting up repos.

## The MakerChecker configuration

Git work is split into separate skills by reversibility. Ordinary version
control (clone, status, diff, commit, fast-forward push) is reversible and is a
low-risk skill the `cc-coding-agent` role holds and runs freely. The
history-rewriting push is a distinct, scoped skill, not a flag on the safe push
skill, so a blanket grant cannot permit rewriting a protected branch.

Two enforcement primitives catch the incident:

- `cc-git-force-push@1` is **not granted** to `cc-coding-agent`. The skill the
  agent reached for after the failed rebase is ungranted to its role, so
  deny-by-default refuses the call before any git remote is touched
  (`skill_not_granted`).
- `cc-git-force-push@1` is published at `riskTier: "high"`. A high-risk skill is
  categorically refused on the proxy: it cannot run ad hoc, even by a role that
  holds the grant. It must run inside a governed flow whose preceding approval
  gate a named repo owner decides (`high_risk_requires_gate`). The proxy refuses
  the owner's direct attempt and points the work at the gate.

Skills (`name@version`, `risk_tier`):

- `cc-git-vcs@1`, `risk_tier: low`. Clone, status, diff, commit, and
  fast-forward push. No history rewriting.
- `cc-git-force-push@1`, `risk_tier: high`. Rewrite a remote branch's history;
  refused on the proxy, allowed only through a gated flow.

Roles and grants (deny by default; only listed grants exist):

- `cc-coding-agent` holds `cc-git-vcs@1` only — no force-push grant.
- `cc-repo-owner` holds `cc-git-force-push@1`, exercised only through the gated
  flow, never ad hoc on the proxy.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/claude-code-force-push-destroyed-git-history/demo.mjs
```

## What happens

```
proxy session c2bc8286-bada-4837-a607-02d664c7eea9 opened

commit: {"ran":"git commit -m 'wip'"}
fast-forward push: {"ran":"git push"}
coding force-push DENIED (skill_not_granted): skill "cc-git-force-push@1" is not granted to the role of agent "cc-coding-bot"
owner ad-hoc force-push DENIED (high_risk_requires_gate): skill "cc-git-force-push@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  33  proxy.session.opened
  34  proxy.check.allowed cc-coding-bot -> cc-git-vcs@1
  35  proxy.result.recorded  -> cc-git-vcs@1
  36  proxy.check.allowed cc-coding-bot -> cc-git-vcs@1
  37  proxy.result.recorded  -> cc-git-vcs@1
  38  enforcement.blocked cc-coding-bot -> cc-git-force-push@1 [skill_not_granted]
  39  enforcement.blocked cc-repo-owner-bot -> cc-git-force-push@1 [high_risk_requires_gate]
  40  proxy.session.closed

audit chain: ok=true events=40
```

Ordinary version control runs unimpeded. The force-push the agent reached for is
refused by deny-by-default, and the repo owner who holds the grant cannot
force-push ad hoc — it is held for a governed flow with a preceding approval
gate. Every attempt, allowed and denied, is written to the hash-chained,
Ed25519-signed audit.

## What this does not prevent

This intercepts the consequential command; it does not change the model's
behavior. It does not stop Claude Code reaching the bad state after a failed
rebase, or choosing force as the next step. The guarantee is narrower: the
history rewrite is ungranted to the coding role and refused, an ad-hoc
force-push is refused on the proxy and held for a governed flow with a named
sign-off, and the signed audit records what was attempted and what ran.
```
