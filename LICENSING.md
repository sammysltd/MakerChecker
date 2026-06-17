# Licensing

MakerChecker is open source under a **split license**, with a **commercial
license** for organizations whose policies preclude AGPL-3.0.

## 1. The split: copyleft core, permissive integration layer

| Component | Package(s) | License |
| --- | --- | --- |
| Control plane | `packages/server`, `packages/web`, `packages/shared` | **AGPL-3.0-only** ([LICENSE](LICENSE)) |
| Integration layer | `packages/sdk`, `packages/sdk-python`, `packages/connector-langchain`, `packages/connector-claude-agent`, `examples/` | **Apache-2.0** ([sdk](packages/sdk/LICENSE), [sdk-python](packages/sdk-python/LICENSE), [langchain](packages/connector-langchain/LICENSE), [claude-agent](packages/connector-claude-agent/LICENSE), [examples](examples/LICENSE)) |

The core is the enforcement engine and the tamper-evident audit chain — the part
an auditor relies on. AGPL-3.0 requires anyone who modifies it and offers it over
a network to publish those modifications. The engine running in production is the
engine a customer's auditors can read.

The integration layer is Apache-2.0: import the SDK, the connectors, and the
examples into a closed-source product without copyleft reaching your code. If you
self-host MakerChecker and integrate over its API or SDK, the AGPL obligations
apply to the MakerChecker service, not to your application.

## 2. Commercial license

Some organizations have procurement or legal policies that do not permit AGPL-3.0
software, even when self-hosted behind their own firewall. A **commercial
license** replaces the AGPL-3.0 terms on the core with conventional commercial
terms (no copyleft obligation), and funds continued development.

To discuss commercial terms: **hello@makerchecker.ai**.

## 3. Contributor License Agreement (CLA)

Offering a commercial license requires that the project hold the rights to
relicense the code. External contributors are asked to sign a **Contributor
License Agreement** granting MakerChecker a perpetual, non-exclusive right to
license their contribution under both the open-source (AGPL-3.0) and the
commercial terms. Contributors retain copyright in their work.

The CLA process is being finalized; until it is automated, a maintainer will ask
first-time contributors to sign before merging. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

*SPDX identifiers: the core is `AGPL-3.0-only`; the integration layer is
`Apache-2.0`. Per-package `license` fields in `package.json` are authoritative.*
