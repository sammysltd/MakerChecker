# Clear the Cache Became Delete the Drive, the Antigravity Wipe

After Google launched the Antigravity agentic IDE in November 2025, a developer
asked the agent to clear a cache folder. In early December 2025 the agent ran a
quiet `rmdir` against the root of the D drive, permanently deleting the entire
partition with no confirmation. Sources:
[TechRadar](https://www.techradar.com/ai-platforms-assistants/googles-antigravity-ai-deleted-a-developers-drive-and-then-apologized),
[awesome-agent-failures case study](https://github.com/vectara/awesome-agent-failures/blob/main/docs/case-studies/google-antigravity-drive-deletion.md),
[PiunikaWeb](https://piunikaweb.com/2025/12/02/google-antigravity-deletes-hard-drive-coding-mishap/).
Full analysis: https://makerchecker.ai/insights/google-antigravity-wiped-entire-drive/.

## The risk

The agent had filesystem access wide enough to reach the drive root. A request
to clear a cache folder resolved to a recursive, silent delete of an entire
partition outside the project, with no checkpoint between the model's path
resolution and the destruction of the data.

## The MakerChecker configuration

Filesystem work is split by blast radius and scope. Reversible reads and writes
confined to the project directory are low-risk skills the coding role holds and
runs before any gate. The destructive variant is a separate skill, not a flag.
Three controls fire in one session:

- `gant-fs-read@1`, `gant-fs-write@1` (low risk). Read, list and write under the
  project root. Granted to the coding role; reversible, so they run pre-gate.
- `gant-fs-rmdir-recursive@1` (**high risk**). Recursively delete a directory
  tree. Not granted to the coding role, so deny-by-default refuses it
  (`skill_not_granted`). Even if granted, the proxy categorically refuses a
  high-risk skill outside a governed flow with a preceding approval gate
  (`high_risk_requires_gate`).
- `gant-fs-clean-cache@1` (low risk). The scoped cleanup that is a real duty,
  granted to the coding role with a path scope pinned to the project root. A
  cache subtree inside the project is allowed; a drive-root target is rejected
  fail-closed (`limit_path`).

Role and grants (deny by default; only listed grants exist):

```text
role: gant-coding-agent-role
  limits:
    gant-fs-read@1:        { maxInvocationsPerRun: 50 }
    gant-fs-clean-cache@1: { pathScope: { field: "path", prefix: "/srv/project" } }
  grants:
    - gant-fs-read@1
    - gant-fs-write@1
    - gant-fs-clean-cache@1
  # gant-fs-rmdir-recursive@1 is NOT granted at first; deny-by-default refuses it.
```

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/google-antigravity-wiped-entire-drive/demo.mjs
```

## What happens

```
proxy session 5cbafe72-58ca-4133-a279-20afbcd1d496 opened

agent reads cache listing: {"read":"/srv/project/.cache/index"}
agent stages a manifest: {"wrote":"/srv/project/.cache/manifest.txt"}
recursive wipe of D:\ DENIED (skill_not_granted): skill "gant-fs-rmdir-recursive@1" is not granted to the role of agent "gant-coding-bot"
high-risk recursive delete DENIED (high_risk_requires_gate): skill "gant-fs-rmdir-recursive@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate
scoped cache clean inside project: {"cleaned":"/srv/project/.cache"}
scoped clean of D:\ DENIED (limit_path): skill "gant-fs-clean-cache@1" path "D:\" for "path" is outside the allowed prefix "/srv/project" — denied

audit trail:
  265  proxy.session.opened
  266  proxy.check.allowed gant-coding-bot -> gant-fs-read@1
  267  proxy.result.recorded  -> gant-fs-read@1
  268  proxy.check.allowed gant-coding-bot -> gant-fs-write@1
  269  proxy.result.recorded  -> gant-fs-write@1
  270  enforcement.blocked gant-coding-bot -> gant-fs-rmdir-recursive@1 [skill_not_granted]
  272  enforcement.blocked gant-coding-bot -> gant-fs-rmdir-recursive@1 [high_risk_requires_gate]
  273  proxy.check.allowed gant-coding-bot -> gant-fs-clean-cache@1
  274  proxy.result.recorded  -> gant-fs-clean-cache@1
  275  enforcement.limit_violation gant-coding-bot -> gant-fs-clean-cache@1 [limit_path]
  276  proxy.session.closed

audit chain: ok=true events=276
```

The reversible reads and writes run. The recursive delete of the drive root is
refused first because the role never held the skill, then, once granted, because
a high-risk skill cannot run on the proxy without a preceding approval gate. The
scoped cleanup runs inside the project but is refused fail-closed against the
drive root. Every attempt, allowed and denied, lands in the hash-chained,
Ed25519-signed audit log with the skill, target path, role and denial reason.

## What this does not prevent

This does not stop the model mis-resolving the cache path or intending the wrong
target. The recursive delete is ungranted and refused, a high-risk delete is
held for a governed flow with a preceding human gate rather than running
silently, and a granted cleanup is confined to the project root so the drive
root is out of reach by construction.
