# CamoLeak: Hidden Markdown Made Copilot Leak Private Source Code (CVE-2025-59145)

Legit Security disclosed CamoLeak (CVSS about 9.6), a vulnerability in GitHub
Copilot Chat. Instructions hidden in invisible markdown inside a pull request or
issue told Copilot Chat to read secrets and source code, then exfiltrate them by
ordering requests to about 100 attacker-controlled images served through
GitHub's own Camo image proxy, which bypassed the Content Security Policy. GitHub
disabled image rendering in Copilot Chat in August 2025; the finding was
disclosed in October 2025.

Sources:
- https://www.legitsecurity.com/blog/camoleak-critical-github-copilot-vulnerability-leaks-private-source-code
- https://www.darkreading.com/application-security/github-copilot-camoleak-ai-attack-exfils-data
- https://www.theregister.com/2025/10/09/github_copilot_chat_vulnerability/

Full analysis: https://makerchecker.ai/insights/camoleak-github-copilot-chat-source-code-exfiltration/

## The risk

The injected instructions drove two actions. First, a broad read of secrets and
private source code beyond the question being answered. Second, an outbound
emission: the ordered image requests to attacker URLs that carried the read data
off the platform. The second action is the irreversible one. Once the bytes
leave on an outbound request, they are gone.

## The MakerChecker configuration

The assistant is a read-and-answer role under deny by default. The safe path is
low-risk: read repository content scoped to the task (`camoleak-repo-read@1`) and
answer in the chat (`camoleak-chat-respond@1`). Both are granted to
`camoleak-assistant-role`.

The outbound emission is never granted. `camoleak-outbound-fetch@1` is published
but bound to no role, so an injected instruction to fetch an attacker URL has no
skill to call: the proxy refuses it with `skill_not_granted` and the exfiltration
channel never opens.

Reading secrets is its own high-risk skill, `camoleak-secrets-read-scoped@1`
(`riskTier: "high"`). The role holds the grant, but the proxy categorically
refuses a high-risk skill with `high_risk_requires_gate`. It must run inside a
governed flow behind a preceding approval gate where a named reviewer signs which
secrets and why, never straight from untrusted chat input. The risk tier, not the
grant, holds the line.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
MAKERCHECKER_URL=http://localhost:3000 \
  node examples/camoleak-github-copilot-chat-source-code-exfiltration/demo.mjs
```

## What happens

```
proxy session fc700fcc-52e9-4f66-8ea4-da6276008a5a opened

assistant reads repo in scope: {"files":"src/payments"}
assistant answers in chat: {"answer":"The payment retry lives in src/payments/retry.ts."}
exfiltration fetch DENIED (skill_not_granted): skill "camoleak-outbound-fetch@1" is not granted to the role of agent "camoleak-copilot-bot"
secret read DENIED (high_risk_requires_gate): skill "camoleak-secrets-read-scoped@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  144  proxy.session.opened
  145  proxy.check.allowed camoleak-copilot-bot -> camoleak-repo-read@1
  146  proxy.result.recorded  -> camoleak-repo-read@1
  147  proxy.check.allowed camoleak-copilot-bot -> camoleak-chat-respond@1
  148  proxy.result.recorded  -> camoleak-chat-respond@1
  149  enforcement.blocked camoleak-copilot-bot -> camoleak-outbound-fetch@1 [skill_not_granted]
  150  enforcement.blocked camoleak-copilot-bot -> camoleak-secrets-read-scoped@1 [high_risk_requires_gate]
  151  proxy.session.closed

audit chain: ok=true events=151
```

The read-and-answer path runs. The outbound exfiltration attempt is refused as an
ungranted skill, and the broad secret read is held because the skill is high-risk
and needs a gate. Every attempt — allowed, ungranted, and gate-required — commits
to the hash-chained, Ed25519-signed audit.

## What this does not prevent

This does not stop Copilot parsing the hidden comment or treating it as an
instruction, and it does not fix the Camo proxy CSP bypass. Deny by default helps
most when the egress is ungranted; had an outbound skill been granted to the role,
this configuration would not have closed the channel. The high-risk gate refuses
the secret read at the proxy but does not itself decide which secrets are
legitimate. That judgment belongs to the named reviewer at the gate inside a
governed flow.
