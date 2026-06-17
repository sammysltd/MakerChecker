# Backup, PITR, and restore drill

The audit chain is the regulatory system of record. A restore is only sound if it
verifies, so this runbook ends every restore in `audit verify` plus an off-box
bundle cross-check.

MakerChecker ships no backup tool. This is operational guidance over standard
Postgres tooling (`pg_dump`/`pg_restore`, or pgBackRest/WAL-G for point-in-time
recovery) plus copying one key file. The product's only contribution here is the
verification step that proves a restore is sound.

## What to back up

Three targets, in three different places, backed up separately.

### 1. The Postgres database

One database holds everything: the hash-chained `audit_events` table, the
`instance` row (genesis anchor + write-once `public_key_pem`), all run state
(`flow_runs`, `step_runs`, `approvals`), every versioned governed entity (roles,
skills, grants, SoD constraints, agents, flows), users and `api_keys`, and the
`graphile_worker` queue schema. There is no second store — a single full backup
covers in-flight jobs too.

In compose, the database is the `pgdata` volume mounted at
`/var/lib/postgresql/data` (`postgres:17-alpine`; db, user, password all
`makerchecker`). A standard full logical or physical backup captures it.

The backup contains `api_keys.key_hash`, users, and the full chain. Protect it
exactly as you protect the live database.

### 2. The instance signing key (separately, off-box)

The Ed25519 private signing key is a file, **not in the database**:
`MAKERCHECKER_DATA_DIR/instance_key.pem` (mode `0600`; default dir `./data`; in
compose the `mcdata` volume at `/data`). It is generated on first boot and only
re-read after that. A `pg_dump` does not capture it. A `pgdata` snapshot does
not capture it.

`instance.public_key_pem` is write-once — a database trigger rejects any in-place
rotation, and the key cannot be replaced under the same instance identity. So a
lost private key is unrecoverable: the instance can never again produce an export
bundle that verifies under its published identity.

Back up and escrow this key **separately** from the database. Whoever can read
both the database and the key can re-sign forged history, so they must have
different blast radius and different custodians (see the escrow ceremony below).

### 3. The off-box signed export bundles

`audit export` produces Ed25519-signed bundles carrying event `count`,
`firstSeq`/`lastSeq`, `headHash`, a digest of all event hashes, and the
`publicKeyPem`. The security model already prescribes retaining these off the
database as an independent anchor on chain height. They are also your restore
cross-check: a restored head that no longer extends the last retained bundle is a
truncation or rollback, not a clean recovery.

Keep them where the database role cannot reach them. Retain them on a fixed
schedule alongside the database backups.

## PITR posture

For point-in-time recovery, use continuous WAL archiving plus periodic base
backups with a standard Postgres tool. These are not bundled.

- **Production (PITR):** pgBackRest or WAL-G. Continuous WAL archiving gives a
  small recovery window; periodic base backups bound restore time.
  - Example RPO: <= 5 min (WAL archived at least every 5 minutes).
  - Example RTO: < 30 min (latest base backup + WAL replay on standby hardware).
- **Small deployments:** scheduled `pg_dump` (full logical dump) on an interval.
  RPO is the dump interval; there is no sub-dump recovery.

Whichever path: also copy `instance_key.pem` once per instance (it never changes)
to its separate escrow, and keep retaining signed bundles. WAL archiving covers
only the database.

Restore the database as a consistent whole, including the `instance` row. The
chain links genesis (derived from `instance.id`) through `prev_hash`; a torn or
partial restore breaks linkage and `audit verify` flags it. Never re-bootstrap a
fresh `instance` row in place of the restored one — a new UUID re-roots the chain
and every linkage breaks at genesis.

## Restore drill

Run this on a schedule against a scratch instance. The drill is not done until
`audit verify` returns `ok: true` **and** the restored head cross-checks against
the last retained signed bundle.

Restore brings back the schema and data — do **not** re-run migrations into a
fresh database. Under the hardened two-role deployment, restore as the **owner**
role (`makerchecker`), not `mc_app_runtime` (which lacks `CREATE` on `public`).

```bash
# 1. Restore the database backup into a scratch instance.
#    pg_dump path (logical):
createdb -U makerchecker makerchecker_restore
pg_restore -U makerchecker -d makerchecker_restore backup.dump
#    PITR path: restore the latest base backup and replay WAL to the target
#    point with pgBackRest/WAL-G, then point DATABASE_URL at the result.

export DATABASE_URL=postgres://makerchecker:makerchecker@localhost:5432/makerchecker_restore

# 2. Restore the signing key to MAKERCHECKER_DATA_DIR (separate escrow copy).
mkdir -p ./restore-data && chmod 700 ./restore-data
cp /escrow/instance_key.pem ./restore-data/instance_key.pem
chmod 600 ./restore-data/instance_key.pem
export MAKERCHECKER_DATA_DIR=./restore-data

# 3. Verify the restored chain (the success criterion). Run from packages/server
#    after a build; needs DATABASE_URL only, no running server.
cd packages/server
node dist/cli.js audit verify
# -> { "ok": true, "count": <restored>, "headHash": "<restored>" }   exit 0
#    exit 1 (ok: false, failedSeq, reason) means the restore is broken — stop.
```

`audit verify` proves the restored chain is internally consistent and
genesis-rooted. It is blind to tail-truncation and rollback: a chain restored
from a stale backup still verifies `ok: true`. Catch that with the bundle
cross-check.

```bash
# 4. Re-verify the last retained off-box bundle offline. --key pins the instance
#    public key obtained out of band, so a chain re-signed with a foreign key is
#    rejected. No database connection is opened.
node dist/cli.js audit verify-bundle --in /escrow/last-bundle.json --key /escrow/instance.pub
# -> { "ok": true, "count": <bundle>, "signingKeyFingerprint": "..." }   exit 0

# 5. Cross-check the restored head/count against the bundle's signed numbers.
#    The drill PASSES only if BOTH hold:
#      restored count  >=  bundle manifest.count
#      restored head   ==  bundle headHash, OR forward-extends it
#    Use a FULL bundle (not a --run bundle); only a full bundle proves
#    completeness via genesis-rooted linkage.
```

If the restored `count` is below the bundle's `count`, or the restored head is
neither the bundle head nor a forward extension of it, the restore lost committed
history. That is a detectable height regression — do not accept it. Restore to at
least the height of the latest retained bundle.

Obtain the pinned public key out of band: from a trusted bundle's
`manifest.publicKeyPem`, or `SELECT public_key_pem FROM instance` against a
trusted deployment. No command emits the PEM.

## Key backup / escrow ceremony

Run once, after the instance's first boot (when `instance_key.pem` is created and
the public key is published to the `instance` row).

1. On the host, confirm the key exists at `MAKERCHECKER_DATA_DIR/instance_key.pem`
   with mode `0600`.
2. Copy it to sealed, off-box storage held by custodians who are **separate from
   the database operators**. A single party must not be able to read both the
   database backup and the key.
3. Record the instance public key out of band for restore-time pinning:
   `SELECT public_key_pem FROM instance` (or take `manifest.publicKeyPem` from a
   trusted bundle), store it as `instance.pub` alongside the escrow record.
4. Verify the escrowed copy restores: on a scratch host, copy it back, run
   `audit verify-bundle --in <retained-bundle> --key instance.pub`, confirm
   `ok: true`.

Recovery path: on restore, copy the escrowed `instance_key.pem` back into
`MAKERCHECKER_DATA_DIR` (mode `0600`) before any `audit export`. The key never
rotates, so one escrowed copy serves for the instance's lifetime.

Key loss is permanent. With the private key gone and `public_key_pem` write-once,
the instance can never sign a verifiable bundle again.

## Optional: pg_dump backup sidecar

A minimal scheduled-`pg_dump` example for evaluation or small self-host. It is
self-contained (its own postgres + `pgdata` volume) and does not inherit
`docker-compose.yml`. For real PITR use pgBackRest or WAL-G instead. This backs up
only the database — escrow `instance_key.pem` separately.

```bash
docker compose -f docker-compose.backup.yml up
```

It dumps as the owner role to a `backups` volume on `BACKUP_INTERVAL_SECONDS`.
Copy dumps off the box and protect them as you protect the live database.

## See also

- [Security model](security-model.md) — off-box bundle retention and the write-once key.
- [Audit spec](audit-spec.md) — bundle manifest fields and offline verification.
- [Quickstart](quickstart.md#cli) — the `audit verify` / `audit export` / `audit verify-bundle` CLI.
