# Security model and hardening

MakerChecker targets regulated, adversarial-insider environments. None of the controls below is reachable by an unauthenticated or ordinary authenticated caller; the guidance here is about deploying for defence in depth, so the audit and enforcement guarantees hold even against a compromised application credential or a privileged insider.

* **Run the server as a non-owner database role in production.** The append-only `audit_events` triggers and the immutable `instance` row guard are enforced at the table level. A PostgreSQL table owner can disable its own triggers, so the production-grade configuration runs the application as a role that does not own those tables and has UPDATE, DELETE, and TRUNCATE privileges revoked on `audit_events` and `instance`. The application role can append audit rows, but cannot modify or delete them, even if the application credentials are compromised. The committed, idempotent [`ops/harden-db.sql`](../ops/harden-db.sql) provisions exactly this: run it once as the table owner after migrations (`psql "$DATABASE_URL_OWNER" -v mc_runtime_password='<strong>' -f ops/harden-db.sql`), then connect the server as `mc_app_runtime`. It is kept out of the normal migrations: `CREATE ROLE` needs elevated privileges that ephemeral test/CI databases do not grant, and the single-role `docker compose` default stays simple for evaluation. The instance public key is published once (the first key-bearing operation, typically the first `audit export` or `audit report`); `ensureInstanceKeys` only writes when the key is absent or differs, so steady state needs only `SELECT` on `instance`. The script grants the role `UPDATE (public_key_pem)` on `instance` for that first publication (or pre-seed `instance.public_key_pem` and drop that grant), after which `SELECT` suffices; the write-once `instance_immutable` trigger blocks any later rotation. The non-owner role does not run `migrate()` at boot (it has no `CREATE` on the public schema), so the owner runs migrations separately and the server starts with `MAKERCHECKER_SKIP_MIGRATE=1`. The ready two-role stack is [`docker-compose.hardened.yml`](../docker-compose.hardened.yml); the Database Hardening Walkthrough section below details the full procedure. The hash chain's recompute-on-read detection applies under either configuration.
* **Retain signed export bundles off-box.** `audit verify` proves the live chain is internally consistent and rooted at genesis. Running `audit export` periodically and retaining the signed bundles off the database gives an independent anchor on the chain's height: each bundle carries the cryptographic signature and metadata including event count and head hash. Truncating the tail or rolling the chain back is detectable as a drop in count or a head that no longer extends a retained bundle. Keep the bundles where the database role cannot reach them.
* **Distribute the instance public key through a trusted channel.** A bundle proves integrity and origin under the key embedded in it; pin the instance public key once, out of band, so a verifier knows which key is legitimate. The `instance` row's `public_key_pem` is write-once (no in-place rotation), so a silent key swap in the database is rejected. Cross-check new bundles against externally retained earlier ones. The off-box bundle history is the anchor that an insider holding the signing key cannot rewrite.
* **Restrict stdio skills with an allowlist in production.** A `stdio` skill spawns a local process (`command` + `args`); registering skills is admin-only. By default the validator denies shells, package-fetching launchers (`npx`, `uvx`, `pip`, and similar tools), and any interpreter flag that evaluates code (it forbids passing recognized runtimes like `node` or `python` any flag, and rejects the `-e`, `-c`, `-m`, `-r`, and `--import` families for every command). For production, set the hard allowlist `MAKERCHECKER_STDIO_ALLOWED_COMMANDS` so only an exact, known set of commands may spawn, pinned to commands you have explicitly approved.
* **SSRF and DNS rebinding are blocked on every outbound path.** Two distinct controls defend outbound HTTP. (1) *Static host validation* (`assertSafeHttpUrl`) rejects literal private, loopback, or link-local IPs and known metadata hostnames, and blocks private hosts entirely unless `MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS=1`. (2) *Connect-time IP pinning* (`skills/ssrf-guard.ts`) defeats DNS rebinding (a public-looking hostname that resolves to a private address at connect time): an undici `Agent` resolves the host (all A/AAAA records), re-checks each address with the same ruleset (`isBlockedIpv4` and `isBlockedIpv6`), and pins the socket to the validated address so there is no second, unchecked resolution before the TCP connect. Every outbound path runs through this pinned dispatcher: the HTTP skill fetch (`skills/invoker.ts`), the outbound webhook fetch (`webhooks/dispatcher.ts`), and the MCP `StreamableHTTPClientTransport` (which accepts our fetch). The MCP path additionally validates the host before the transport is built. The `MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS=1` opt-in disables private-IP rejection for localhost dev and test only; leave it unset in production and restrict egress at the network layer for defence in depth.
* **Secrets never reach the logs.** The server emits structured JSON logs (one access line per request, plus boot/worker lines), with the level set by `MAKERCHECKER_LOG_LEVEL` (`trace`…`fatal`, or `silent`; default `info`). Pino `redact` paths mask the `authorization` header, `cookie`, and the obvious secret field names (`token`, `apiKey`, `password`, `secret`), and the access line logs the method, URL, status, timing, and correlation id but never the request body or the Bearer token. A request carries an `x-request-id` through as its correlation id when supplied (an opaque tracing token only, never trusted for authorization). Error logs scrub the error text through the same `MAKERCHECKER_REDACTION` hook used on the write, read, and webhook paths, so attacker-influenced messages cannot leak PII into a log line.
* **Demo seeding is opt-in.** The bundled demo (an admin account, sample agents, and flows, and the demo local skills) is seeded only when `MAKERCHECKER_SEED_DEMO=1`. A default image (the variable unset) seeds nothing, so no admin account or admin API key is created on a production deployment. The demo local skills read files only within the configured `DEMO_DATA_DIR` tree (specifically its parent directory, where the sibling sample data lives); a caller-supplied path that escapes that tree is rejected, and with `DEMO_DATA_DIR` unset the skills read nothing.
* **The first admin is created by an explicit operator command, never at boot.** Because a default image seeds nothing, the first identity on a fresh deployment is minted with the `bootstrap-admin` CLI command (`node packages/server/dist/cli.js bootstrap-admin --email <e> --name <n>`), which creates one admin user and issues its API key, printing the plaintext key once and writing `user.created` and `api_key.created` to the audit chain. This is the supported path: there is no auto-provisioning step, so a running server with compromised application credentials cannot silently gain a new admin through normal boot, and no admin exists until an operator deliberately creates one. Re-running it for an existing email fails rather than creating a second admin. `create-user` (optionally `--admin`) mints further identities without a key. See [Quickstart → First admin on a fresh deployment](quickstart.md#first-admin-on-a-fresh-deployment).
* **Role limits are schema-validated at write time.** `POST /roles` rejects a malformed `roles.limits` object with a 400 before the role is saved (`validateRoleLimitsHook` in `api/admin-routes.ts`, a strict non-coercing ajv check against the `RoleLimits` TypeBox schema that mirrors `RoleLimits` and `SkillLimitConfig` in `engine/limits.ts`). Coercion is off so a value like `"7"` is not silently rewritten to `7` and a ceiling cannot be retargeted by a type change. The runtime checks in `engine/limits.ts` fail **closed** (deny rather than pass) on any limit they cannot interpret, so a malformed ceiling that reached the database some other way is still denied at decision time.
* **Run limits are pinned per run.** A run's role limits are frozen once per `(run, role)`, so a mid-run edit to `roles.limits` cannot raise an in-flight run's ceiling. Reassigning the agent to a different role (`PATCH /agents/:id`, admin-only) resolves the new role's limits on the next step; an administrator can already set limits for future runs, so this is admin-controlled determinism within the same trust boundary, not a privilege escalation.
* **Strict segregation of duties forbids every self-approvable gate.** Setting `MAKERCHECKER_REQUIRE_IDENTITY_GATES=1` enforces four-eyes at both layers and fails closed: publishing rejects any flow with a non-separation-enforcing approval gate (`validateRiskTiers` in `engine/flows.ts`), and at decision time the run's own requester — admin included — is denied with an audited `approval.decision_denied` event even on a legacy gate published before strict mode was enabled (`checkDecisionIdentity` in `engine/orchestrator.ts`), with unauthenticated decisions denied. Default unset leaves legacy gates with their existing behavior.
* **Auth-disabled mode refuses a reachable bind.** With `MAKERCHECKER_AUTH_DISABLED=1` the API auth hook and admin gating are bypassed, so the server fails closed at startup unless it binds loopback (`127.0.0.1` / `::1` / `localhost`): `assertAuthBindSafe` in `boot/bind-guard.ts` throws before `app.listen` on any reachable host, an unset or unrecognized host counting as reachable.

## Database Hardening Walkthrough

This walkthrough runs the application with a non-owner database role, so an attacker who compromises the application credentials cannot disable database triggers.

### Runtime Role Capabilities

After executing `ops/harden-db.sql`, the `mc_app_runtime` role has the following permissions:

**Allowed Operations**
* Connect to the database and use the `public` schema.
* Read and write to mutable run-state tables (such as `flow_runs`, `step_runs`, and `approvals`).
* Read and append rows to the `audit_events` table.
* Read the `instance` table, and perform a single update to publish the instance signing key during first boot.
* Access the `graphile_worker` queue schema.

**Prohibited Operations**
* Modifying or deleting rows in the `audit_events` table.
* Modifying the `instance` table after the initial key publication.
* Disabling the triggers on any database table.

### Applying Hardening Manually

To configure the roles manually, run migrations as the database owner, apply the hardening script, and then connect the application server using the runtime role credentials.

```bash
# 1. Run database migrations as the owner
DATABASE_URL="$DATABASE_URL_OWNER" node packages/server/dist/cli.js migrate

# 2. Apply the hardening script as the owner. Provide a strong password:
psql "$DATABASE_URL_OWNER" \
  -v mc_runtime_password='<strong-password>' \
  -f ops/harden-db.sql

# 3. Start the server using the runtime role and skip boot-time migrations
DATABASE_URL="postgres://mc_app_runtime:<strong-password>@HOST:5432/DB" \
  MAKERCHECKER_SKIP_MIGRATE=1 \
  node packages/server/dist/index.js
```

The hardening script is idempotent. Re-running it re-asserts the privileges without altering the password. To rotate the runtime password, run `ALTER ROLE mc_app_runtime PASSWORD '<new>'` as a database superuser.

### Applying Hardening with Docker Compose

The `docker-compose.hardened.yml` file automates the database setup, migration, hardening, and server startup.

```bash
MC_RUNTIME_PASSWORD=<strong-password> \
  docker compose -f docker-compose.hardened.yml up --build
```

### Verifying Hardening Controls

To verify that the permissions are restricted, connect to the database as the `mc_app_runtime` user and execute the following checks:

```sql
SELECT has_table_privilege('audit_events', 'INSERT');  -- Expected: true
SELECT has_table_privilege('audit_events', 'UPDATE');  -- Expected: false
SELECT has_table_privilege('audit_events', 'DELETE');  -- Expected: false
```

Attempting to bypass the triggers will result in permission errors:

```sql
UPDATE audit_events SET event_type = 'x';                       -- Permission denied
DELETE FROM audit_events;                                       -- Permission denied
ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete; -- Must be owner
```

## Auditing the audit chain

The audit chain's verification is fully specified in the [audit spec](audit-spec.md) and reproducible offline, in any language, with no access to our systems. Findings against the chain, the canonicalization, or the signed export bundles are in scope in [SECURITY.md](../SECURITY.md).
