# Licensing

MakerChecker is open source under a **split license**, with a **commercial
license** available for organizations whose policies preclude AGPL-3.0.

## 1. The split: copyleft core, permissive integration layer

| Component | Package(s) | License |
| --- | --- | --- |
| Control plane | `packages/server`, `packages/web`, `packages/shared` | **AGPL-3.0-only** ([LICENSE](LICENSE)) |
| Integration layer | `packages/sdk`, `packages/sdk-python`, `packages/connector-langchain`, `packages/connector-claude-agent`, `examples/` | **Apache-2.0** ([sdk](packages/sdk/LICENSE), [sdk-python](packages/sdk-python/LICENSE), [langchain](packages/connector-langchain/LICENSE), [claude-agent](packages/connector-claude-agent/LICENSE), [examples](examples/LICENSE)) |

**Why AGPL for the core.** The control plane is the part an auditor relies on:
the enforcement engine and the tamper-evident audit chain. AGPL-3.0 keeps it
honest. Anyone who modifies the core and offers it over a network must publish
those modifications, so the engine a customer's auditors read is the engine
running in production. There is no proprietary fork that quietly diverges from
the public, independently verifiable one.

**Why Apache for the integration layer.** Calling MakerChecker's APIs from your
own application must never place obligations on your code. The SDK, the LangChain
connector, and the examples are Apache-2.0: import them, embed them, ship them in
a closed-source product — no copyleft reaches your codebase. The boundary is the
network API. Your side of it stays entirely yours.

If you self-host MakerChecker and integrate with it over its API or SDK, the
AGPL obligations apply to the MakerChecker service, not to your application.

## 2. Commercial license

Some organizations have procurement or legal policies that do not permit AGPL-3.0
software, even when self-hosted behind their own firewall. For those cases a
**commercial license** is available that replaces the AGPL-3.0 terms on the core
with conventional commercial terms (no copyleft obligation).

The commercial license is also how we fund continued development, and it is the
delivery vehicle for closed enterprise add-ons (for example SSO/SAML,
multi-tenancy controls, and HSM/KMS-backed signing keys).

To discuss commercial terms: **hello@makerchecker.ai**.

## 3. Contributor License Agreement (CLA)

Offering a commercial license requires that the project hold the rights to
relicense the code. To preserve that, external contributors are asked to sign a
**Contributor License Agreement** granting MakerChecker a perpetual,
non-exclusive right to license their contribution under both the open-source
(AGPL-3.0) and the commercial terms. Contributors retain copyright in their work.

The CLA process is being finalized; until it is automated, a maintainer will ask
first-time contributors to sign before merging. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

*SPDX identifiers: the core is `AGPL-3.0-only`; the integration layer is
`Apache-2.0`. Per-package `license` fields in `package.json` are authoritative.*
