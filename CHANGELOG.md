# Changelog

All notable changes to MakerChecker are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-16

First public release.

### Added

- Roles, agents, and versioned skills (MCP/HTTP/local) with risk tiers; deny-by-default grants with revocation.
- Segregation-of-duties constraints enforced at both decision and invocation time.
- Flows with approval gates, retries, timeouts, and a crash-recovery watchdog.
- n-of-m named approvals: quorums, named approver lists, and requester self-approval forbidden by default (fail closed).
- Enforced role limits and budgets: per-skill invocation caps, fail-closed amount ceilings, run-level invocation and token budgets.
- Proxy sessions that wrap agents in any framework (LangChain, CrewAI, LlamaIndex, AutoGen, the Claude Agent SDK) with grant checks, SoD, and the audit trail; typed connectors for LangChain and the Claude Agent SDK plus generic middleware recipes.
- Hash-chained, append-only audit log with Ed25519-signed, offline-verifiable export bundles and a CLI verifier.
- Evidence packs: self-contained HTML run reports and role/grant/SoD access-review reports.
- Cron, event, and manual/API triggers; HMAC-signed outbound webhooks with retries and a failure counter.
- Real-model execution (Anthropic, Gemini/OpenAI-compatible) with a deterministic, air-gapped fallback.
- API-key auth, a React UI (run viewer, approvals inbox, registry), a typed SDK, and an OpenAPI document.

[1.0.0]: https://github.com/sammysltd/makerchecker/releases/tag/v1.0.0
