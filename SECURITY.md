# Security Policy

## Supported versions

Security fixes land on the latest 1.x release and the `main` branch.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (the **Report a vulnerability** button under the Security tab), or email **hello@makerchecker.ai**.

Please include a reproduction or proof of concept where possible. You should receive an acknowledgement within 72 hours.

We follow **90-day coordinated disclosure**: we ask that you give us 90 days from your report before public disclosure; we will credit you (unless you prefer otherwise) and aim to ship fixes well inside that window. Good-faith research under this policy will not be met with legal action.

## In scope

Reports in these areas are especially valuable: they attack the product's core claims:

- **Audit chain tamper-evidence.** Any way to modify, remove, insert, or reorder audit events without detection by `audit verify` or bundle verification; any way to forge a bundle that verifies under a key you do not hold; canonicalization ambiguities that let two different events produce the same hash.
- **Enforcement bypasses.** Executing a skill without an active grant, evading a segregation-of-duties constraint, running a high-risk skill without a preceding approval gate, or acting as a suspended or retired agent (either at decision time or invocation time).
- **Authentication.** API-key handling, key-hash storage, auth-hook gaps (routes reachable without a valid key when auth is enabled).

Also in scope: SQL injection, SSRF via skill implementations or webhooks, and secrets leaking into logs or audit payloads.

## Out of scope

- Deployments running with `MAKERCHECKER_AUTH_DISABLED=1` (explicitly a local demo mode).
- Denial of service via resource exhaustion on unauthenticated endpoints (`/healthz`).
- Vulnerabilities in dependencies without a demonstrated impact on MakerChecker.

## Security model

MakerChecker is built for regulated, adversarial-insider environments. The production hardening guidance below keeps the audit and enforcement guarantees intact even against a compromised application credential or a privileged insider. The full walkthrough and the rationale for each control are in [docs/security-model.md](docs/security-model.md).

- **Run as a non-owner database role.** `REVOKE` `UPDATE`/`DELETE`/`TRUNCATE` on `audit_events` and `instance` so a compromised app credential can append audit rows but never mutate, delete, or disable the append-only guards. Provisioned by [`ops/harden-db.sql`](ops/harden-db.sql); two-role stack in [`docker-compose.hardened.yml`](docker-compose.hardened.yml).
- **Retain signed export bundles off-box.** Ed25519-signed bundles carry the event count and head hash; keeping them where the database role cannot reach them anchors the chain height, so truncation or rollback is detectable.
- **Distribute the instance public key out of band.** `instance.public_key_pem` is write-once, so a silent key swap in the database is rejected; pin the key through a trusted channel.
- **Restrict stdio skills with an allowlist.** The validator denies shells, package-fetching launchers, and code-evaluating interpreter flags by default; set `MAKERCHECKER_STDIO_ALLOWED_COMMANDS` in production so only an explicit, known set of commands may spawn.
- **SSRF and DNS rebinding are blocked on every outbound path** (skill fetch, webhooks, MCP transport) by static host validation plus connect-time IP pinning. Leave `MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS` unset in production.
- **Demo seeding is opt-in.** With `MAKERCHECKER_SEED_DEMO` unset, no admin account or admin API key is created.
- **Role limits fail closed.** Limits are schema-validated (non-coercing) at write time and pinned per `(run, role)`; the runtime denies any limit it cannot interpret.

## Auditing the audit chain

The audit chain's verification is fully specified in the [audit spec](docs/audit-spec.md) and designed to be reproduced offline, in any language, by anyone, with no access to our systems required. Attacks on its tamper-evidence are the most valuable reports we can receive: that open, reproducible spec is the review. Findings against the chain, the canonicalization, or the signed export bundles are explicitly in scope above.
