# Agent Incident Database (AID)

A citable, CVE-style catalog of real-world incidents where an AI agent or
automated system took a **consequential action that a maker-checker control
would have blocked or contained**. Every entry has a stable id, structured
fields, primary sources, and — where available — a runnable MakerChecker
reproduction that demonstrates the block.

This is a public reference. Cite an incident by its id (e.g. `AID-2023-0002`).
The id namespace and the citation graph are the point: the markdown is easy to
copy, the canonical reference is not.

- **Machine-readable registry:** [index.json](index.json)
- **Entry schema:** [schema.json](schema.json)
- **Add or correct an incident:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **20 incidents** currently catalogued, all reproducible.

## Scope

This catalogue covers incidents where an automated system took a consequential
action a human should have owned and could not take back. The core is AI-agent
failures. A few older cases, for example Knight Capital in 2012 and Robodebt in
2015, are included as precedents and marked `_(precedent)_` in the table below,
because the failure mode is the same even though the system was not an LLM agent.
Where an incident was a researcher proof-of-concept that was fixed before real
harm, the entry says so. Where a human, not the agent, took the final action, the
entry says that too.

## Incidents

| ID | Date | Incident | Category | Severity |
|---|---|---|---|---|
| [`AID-2026-0005`](entries/AID-2026-0005.md) | March 2026 | Meta AI Agent Skipped Required Human Review; Flawed Guidance Led to Broad Data Access | Wrongful automated decision | critical |
| [`AID-2026-0004`](entries/AID-2026-0004.md) | May 4, 2026 | Morse Code Prompt Injection Drained Grok-Connected Wallet of $150K | Binding commitment | critical |
| [`AID-2026-0003`](entries/AID-2026-0003.md) | May 9-10, 2026 | DN42 Network Scan Agent Spawned $6,531 AWS Bill via Uncontrolled Provisioning Loop | Runaway execution | critical |
| [`AID-2026-0002`](entries/AID-2026-0002.md) | 25 April 2026 | Cursor Agent Deleted Production Database and Backups via Over-Privileged Railway Token | Data loss | critical |
| [`AID-2026-0001`](entries/AID-2026-0001.md) | March 11, 2026 | Claude Code Force-Pushed Over Private Repository and Destroyed Commit History | Data loss | critical |
| [`AID-2025-0006`](entries/AID-2025-0006.md) | June–September 2025 | ShadowLeak: Zero-Click Gmail Exfiltration via ChatGPT Deep Research Agent | Data exfiltration | critical |
| [`AID-2025-0005`](entries/AID-2025-0005.md) | July 2025 | Replit Agent Deleted Production Database During Code Freeze | Data loss | critical |
| [`AID-2025-0004`](entries/AID-2025-0004.md) | 2025-2026 | MyPillow Attorney Filings with Fabricated Citations and a Repeat Miscitation | Fabrication | high |
| [`AID-2025-0003`](entries/AID-2025-0003.md) | December 2025 | Google Antigravity Agent Permanently Deleted Developer's Entire D Drive | Data loss | critical |
| [`AID-2025-0002`](entries/AID-2025-0002.md) | June 2025 | Microsoft 365 Copilot Zero-Click Exfiltration via Prompt Injection (CVE-2025-32711) | Data exfiltration | critical |
| [`AID-2025-0001`](entries/AID-2025-0001.md) | October 2025 | CamoLeak: GitHub Copilot Chat Exfiltrates Private Source Code via Hidden Markdown Instructions | Data exfiltration | critical |
| [`AID-2023-0003`](entries/AID-2023-0003.md) | November 2023 | UnitedHealth nH Predict Denied Medicare Post-Acute Care Without Clinician Authorization | Wrongful automated decision | critical |
| [`AID-2023-0002`](entries/AID-2023-0002.md) | 2023 | Attorneys filed ChatGPT-hallucinated case citations to federal court | Fabrication | high |
| [`AID-2023-0001`](entries/AID-2023-0001.md) | December 18, 2023 | Chevrolet of Watsonville: Prompt-Injected Chatbot Agreed in Conversation to Sell a Vehicle for $1 | Binding commitment | high |
| [`AID-2022-0003`](entries/AID-2022-0003.md) | May 2, 2022 | Citigroup $444B Basket: Hard Blocks Caught ~$255B, No Notional Ceiling on the Rest _(precedent)_ | Unauthorized financial action | critical |
| [`AID-2022-0002`](entries/AID-2022-0002.md) | 2022 | Cigna PxDx Batch Rubber-Stamp Denials | Binding commitment | critical |
| [`AID-2022-0001`](entries/AID-2022-0001.md) | November 2022 | Air Canada Held Liable for Chatbot's Misstated Bereavement Refund Policy | Binding commitment | high |
| [`AID-2015-0001`](entries/AID-2015-0001.md) | 2015-2019 | Australia Robodebt: Unlawful Automated Welfare Debt Calculation _(precedent)_ | Wrongful automated decision | critical |
| [`AID-2013-0001`](entries/AID-2013-0001.md) | August 16, 2013 | Everbright Securities Arbitrage System Runaway Orders with Undisclosed Insider Hedge Cover Trade _(precedent)_ | Runaway execution | critical |
| [`AID-2012-0001`](entries/AID-2012-0001.md) | August 1, 2012 | Knight Capital $440M Runaway Trading Loss _(precedent)_ | Runaway execution | critical |

## Controls that would have blocked these

Every incident maps to one or more structural controls. Across the catalogue:

| Control | Incidents it would have blocked |
|---|---|
| High-risk approval gate (high_risk_requires_gate) | 18 |
| Deny-by-default (skill_not_granted) | 15 |
| Fail-closed limits (limit_violation) | 6 |
| Segregation of duties (sod_violation) | 5 |
| Named approval gate | 3 |
| independent_citation_verification | 1 |
| human_separation_of_duties | 1 |

The recurring lesson: in nearly every case the model was free to *propose*, but
nothing structural stopped it from *committing* the irreversible action. That
gap — not the model's mistake — is the incident.

## Accuracy, disclaimer, and corrections

Entries describe publicly reported incidents, summarized from the sources cited
in each entry. Summaries may contain errors, and claims drawn from pending
litigation are labeled as allegations rather than established fact. If you spot
an error, email [hello@makerchecker.ai](mailto:hello@makerchecker.ai) or open a
PR (see [CONTRIBUTING.md](CONTRIBUTING.md)). Confirmed factual errors are
corrected within 14 days of report.

---

_Maintained by [MakerChecker](https://makerchecker.ai). Entries are derived from
the JSON sources in [`entries/`](entries); regenerate with
`node incidents/scripts/build.mjs`._
