# ShadowLeak: Zero-Click Gmail Exfiltration via the ChatGPT Deep Research Agent

Radware disclosed ShadowLeak around June 2025. A hidden instruction planted in
an email made the ChatGPT Deep Research agent encode Gmail data and request an
attacker-controlled URL from inside OpenAI's own cloud, so the egress never
crossed the victim's network and was invisible to local defenses. OpenAI
patched it around August 2025, after the same indirect-injection path was shown
to extend to many connectors. The agent was doing what the injected text told
it to: read the mailbox and fetch a URL.

Sources:
- https://www.radware.com/blog/threat-intelligence/shadowleak/
- https://thehackernews.com/2025/09/shadowleak-zero-click-flaw-leaks-gmail.html
- https://www.infosecurity-magazine.com/news/vulnerability-chatgpt-agent-gmail/

Full analysis: https://makerchecker.ai/insights/shadowleak-chatgpt-deep-research-gmail-exfiltration/

## The risk

An agent scoped to a single read task (summarize a Gmail inbox) takes two
consequential actions on the strength of attacker text it read in a message:
it reaches connectors beyond its task (Drive, GitHub) and it performs outbound
egress to an arbitrary URL. The data leaves through the agent's own runtime, so
a network egress filter on the user side never sees it.

## The MakerChecker configuration

The `shadowleak-inbox-reader` role is scoped to a single read task. It is
granted `shadowleak-gmail-read@1` (its in-scope mailbox read) and nothing else
by way of cross-connector reach: `shadowleak-drive-read@1` is published but
**never granted** to this role, so
the cross-connector read the injection asks for is refused by deny-by-default
before any data is read.

Outbound fetch (`shadowleak-net-fetch@1`) is published with `riskTier: "high"`.
This demo grants it to the role to show the next line of defense: even granted,
a high-risk skill is categorically refused on the proxy with
`high_risk_requires_gate`. It runs only inside a governed flow with a preceding
approval gate, where a different named approver clears the outbound fetch before
it executes.

To restrict URL egress to an allowlist rather than a blanket gate, write a
distinct high-risk skill (for example `net-fetch-allowlisted@1`) whose
implementation enforces the allowed destinations. MakerChecker enforces grants
by skill name and version, not by argument values, so a per-destination limit
lives inside the skill.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/shadowleak-chatgpt-deep-research-gmail-exfiltration/demo.mjs
```

## What happens

```
proxy session 6bb4a1c9-957e-49c3-bc38-6106b8d0e17a opened

inbox summary: {"summary":"read 42 messages from victim@example.com"}
cross-connector drive-read DENIED (skill_not_granted): skill "shadowleak-drive-read@1" is not granted to the role of agent "shadowleak-inbox-bot"
exfiltration net-fetch DENIED (high_risk_requires_gate): skill "shadowleak-net-fetch@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  340  proxy.session.opened
  341  proxy.check.allowed shadowleak-inbox-bot -> shadowleak-gmail-read@1
  342  proxy.result.recorded  -> shadowleak-gmail-read@1
  343  enforcement.blocked shadowleak-inbox-bot -> shadowleak-drive-read@1 [skill_not_granted]
  344  enforcement.blocked shadowleak-inbox-bot -> shadowleak-net-fetch@1 [high_risk_requires_gate]
  345  proxy.session.closed

audit chain: ok=true events=345
```

The mailbox read is allowed; the cross-connector read is refused by
deny-by-default; the exfiltration fetch is refused because it is high-risk and
must run behind an approval gate. Every attempt and decision is written to the
hash-chained, Ed25519-signed audit, even though the network egress itself would
have been invisible to local defenses.

## What this does not prevent

This does not stop the agent from believing the email, and it does not reach
inside OpenAI's infrastructure or any vendor runtime you do not control. The
ShadowLeak fetch happened in OpenAI's cloud, outside any control plane the
victim ran. The mapping applies to agents you build on MakerChecker, where the
connector reads and the outbound fetch are skills MakerChecker authorizes before
they execute.
