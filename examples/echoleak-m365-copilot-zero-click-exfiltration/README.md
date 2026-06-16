# EchoLeak: A Single Email Made Copilot Exfiltrate Your Files (CVE-2025-32711)

Aim Security disclosed EchoLeak (CVSS 9.3), a zero-click vulnerability in
Microsoft 365 Copilot. A crafted email carried hidden instructions that
Copilot's RAG pulled into context. Those instructions made the assistant gather
data from OneDrive, SharePoint, and Teams and exfiltrate it through
auto-fetched images, with no user click required. Microsoft patched it
server-side. Sources:
[The Hacker News](https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html),
[SecurityWeek](https://www.securityweek.com/echoleak-ai-attack-enabled-theft-of-sensitive-data-via-microsoft-365-copilot/),
[Business Wire](https://www.businesswire.com/news/home/20250611349150/en).
Full analysis: https://makerchecker.ai/insights/echoleak-m365-copilot-zero-click-exfiltration/.

## The risk

Injected context tells the agent to read broadly across connected stores and
then send what it found to an attacker-controlled URL. The consequential action
is the outbound step: a `net.fetch` to an external host carrying file data as a
query string or as the source of an auto-loaded image. Reading widely is bad;
the loss event is the egress.

## The MakerChecker configuration

The agent that answers over corporate data holds only the skills its task needs,
each as `name@version`, deny by default. The `echoleak-copilot-assistant` role is
granted `echoleak-doc-search@1` and `echoleak-answer-compose@1` only. The
outbound channel `echoleak-net-fetch@1` is **not granted**, and neither is the
sanctioned send `echoleak-data-egress-send@1`. An attempt to use either from the
assistant is refused by deny-by-default before any tool body runs.

The one path that can ever leave data the org is `echoleak-data-egress-send@1`,
published at `riskTier: high`. A high-risk skill is categorically refused on the
proxy: it cannot run through a raw governed call and must instead run inside a
governed flow with a preceding approval gate. So even the `echoleak-data-release-officer`
role — the only role that holds the egress grant — cannot fire the send directly.
That role's grant additionally carries an `allowlist` on the `destination` field,
so an approved send can only reach an approved host; the attacker URL is off the
list and fails closed.

## Run it

Boot the server (`docker compose up`, or locally with
`MAKERCHECKER_AUTH_DISABLED=1`) and build the SDK (`corepack pnpm run build`),
then:

```bash
node examples/echoleak-m365-copilot-zero-click-exfiltration/demo.mjs
```

## What happens

The injected email reaches the model and the model is fooled. That is taken as a
given. The agent searches and composes on the legitimate path, then attempts to
exfiltrate. Every attempt — allowed and denied — is captured.

```
proxy session 1d939490-ec2a-46fe-b9d7-2ee33b0aa12d opened

assistant searches corpus: {"hits":3,"query":"Q2 revenue summary"}
assistant composes answer: {"draft":"answer to: Q2 revenue summary"}
assistant net.fetch DENIED (skill_not_granted): skill "echoleak-net-fetch@1" is not granted to the role of agent "echoleak-copilot-bot"
assistant data-egress DENIED (skill_not_granted): skill "echoleak-data-egress-send@1" is not granted to the role of agent "echoleak-copilot-bot"
officer egress (no gate) DENIED (high_risk_requires_gate): skill "echoleak-data-egress-send@1" is high-risk and cannot run through the proxy; run it in a governed flow with a preceding approval gate

audit trail:
  330  proxy.session.opened
  331  proxy.check.allowed echoleak-copilot-bot -> echoleak-doc-search@1
  332  proxy.result.recorded  -> echoleak-doc-search@1
  333  proxy.check.allowed echoleak-copilot-bot -> echoleak-answer-compose@1
  334  proxy.result.recorded  -> echoleak-answer-compose@1
  335  enforcement.blocked echoleak-copilot-bot -> echoleak-net-fetch@1 [skill_not_granted]
  336  enforcement.blocked echoleak-copilot-bot -> echoleak-data-egress-send@1 [skill_not_granted]
  337  enforcement.blocked echoleak-release-bot -> echoleak-data-egress-send@1 [high_risk_requires_gate]
  338  proxy.session.closed

audit chain: ok=true events=338
```

The assistant's attempt to reach the attacker host is refused as ungranted: there
is no outbound channel to act on the stolen context. The sanctioned send is also
ungranted to the assistant, and even to the role that does hold it the proxy
refuses the high-risk send outside a gated flow. The denied `net.fetch`, the
ungranted egress, and the gate-required refusal are all written to the
hash-chained, Ed25519-signed audit and are offline-verifiable.

## What this does not prevent

This does not make the model resistant to prompt injection and it does not parse
or strip hidden text out of retrieved content. The model can still be fooled by
the crafted email. The control only helps when reads and egress are gated tool
calls: it shrinks the blast radius so a task-scoped agent cannot pivot to broad
reads and then an outbound URL, and it forces any data-bearing send through a
high-risk gate. If an egress channel is granted to the acting role and left
ungated and unconstrained, this configuration does not stop the exfiltration.
