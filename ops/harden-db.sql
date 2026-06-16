-- MakerChecker DB least-privilege hardening (Layer 2 in SECURITY.md / 0001_init.sql).
--
-- WHAT THIS CLOSES
--   The append-only audit_events triggers and the immutable instance-row guard
--   bind at the TABLE level, but a PostgreSQL table OWNER can DISABLE its own
--   triggers (ALTER TABLE ... DISABLE TRIGGER) and then UPDATE/DELETE freely.
--   The single-role docker/quickstart default connects as the owner, so a
--   compromised application credential could silently rewrite the audit log.
--   This script provisions a separate runtime role that does NOT own any table
--   and is REVOKEd UPDATE/DELETE/TRUNCATE on the tamper-evident tables, so it
--   can APPEND audit rows but can never mutate, delete, truncate, or disable the
--   guards on them. This is the non-owner runtime role referenced in SECURITY.md.
--
-- HOW TO USE (two-role pattern)
--   1. The OWNER role (the role that created the database and ran the migrations)
--      applies this script ONCE, after migrations:
--
--        psql "$DATABASE_URL_OWNER" -v mc_runtime_password='<strong-password>' \
--          -f ops/harden-db.sql
--
--      Re-running it is safe: every statement below is idempotent.
--   2. Point the server's DATABASE_URL at mc_app_runtime (NOT the owner). See
--      docker-compose.hardened.yml for the compose form.
--
--   This script does NOT run as part of the normal migrations on purpose:
--   CREATE ROLE needs elevated privileges that ephemeral CI/test databases (which
--   run as a single owner/superuser and intentionally DISABLE triggers in
--   adversarial tests) do not grant. The default single-role flow stays untouched.
--
-- IDEMPOTENCY / SAFETY
--   Run as the table owner (or a superuser). The runtime password is read from
--   the psql variable :mc_runtime_password and defaults to 'mc_app_runtime' only
--   so the script never fails when invoked without it; ALWAYS pass a real
--   password in any deployment you care about, or set it out of band with
--   ALTER ROLE mc_app_runtime PASSWORD '...'.

\set ON_ERROR_STOP on

-- Default the password variable when the caller did not pass one. psql has no
-- "default if unset", so test it with a sentinel and override only when missing.
\if :{?mc_runtime_password}
\else
  \set mc_runtime_password 'mc_app_runtime'
\endif

------------------------------------------------------------------------------
-- 1. Runtime role. CREATE ROLE is not idempotent, so emit it only when the role
--    is absent (\gexec runs the row this SELECT returns, none if it exists).
--    LOGIN so the server can connect; NOSUPERUSER/NOCREATEDB/NOCREATEROLE so a
--    compromised credential cannot escalate. The password is set in the same
--    CREATE because the value is interpolated by psql here; psql does NOT
--    substitute :variables inside a dollar-quoted DO block, so this stays at the
--    top level.
--
--    Re-runs do NOT reset the password: ALTER ROLE ... PASSWORD requires
--    superuser or ADMIN on the role, which a plain table-owner running this
--    script may not hold (roles are cluster-global, so the role can pre-exist).
--    To rotate the password later, run as superuser (or a role with ADMIN on
--    mc_app_runtime): ALTER ROLE mc_app_runtime PASSWORD '<new>'.
------------------------------------------------------------------------------
SELECT format(
  'CREATE ROLE mc_app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE '
  || 'NOINHERIT PASSWORD %L',
  :'mc_runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_app_runtime')
\gexec

------------------------------------------------------------------------------
-- 2. Connect + schema usage. The role needs to reach the database and resolve
--    objects in the public schema, but no DDL rights there (it must not be able
--    to CREATE shadow tables or functions). current_database() keeps the script
--    portable across database names.
------------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mc_app_runtime', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO mc_app_runtime;

------------------------------------------------------------------------------
-- 3. Baseline DML on every existing application table. The server reads and
--    writes mutable run-state (flow_runs, step_runs, approvals, ...) and appends
--    to the governed/append-only tables. We grant the full SELECT/INSERT/UPDATE/
--    DELETE set broadly here, then REVOKE the dangerous verbs back from the
--    tamper-evident tables in step 4. Sequences backing identity/serial columns
--    need USAGE so INSERTs can draw default values.
------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mc_app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mc_app_runtime;

-- In the hardened flow the runtime role runs with MAKERCHECKER_SKIP_MIGRATE=1
-- and never calls migrate(); the owner applies migrations before this script.
-- This SELECT/INSERT grant is therefore for operational/diagnostic reads of the
-- migration ledger, not for boot.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    GRANT SELECT, INSERT ON schema_migrations TO mc_app_runtime;
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 4. graphile_worker queue access. The owner installs the graphile_worker schema
--    during `migrate` (migrateGraphileWorkerSchema); the runtime role only USES
--    it — graphile-worker's startup migrate is a no-op once the schema is current,
--    so the runtime role never needs CREATE. Grant USAGE + table/sequence/function
--    privileges on the existing objects, plus matching DEFAULT PRIVILEGES keyed to
--    the schema owner so future graphile-worker upgrades stay covered. graphile-
--    worker ENABLEs row-level security on its job tables but ships NO policies
--    (RLS-on + no-policy = deny-all for non-owners, while the owner bypasses it),
--    so a permissive ALL policy per RLS table is required for the non-owner role
--    to enqueue/consume. If the schema is absent the operator skipped `migrate`;
--    warn and continue (the rest of this script is still valid for the app tables).
------------------------------------------------------------------------------
DO $$
DECLARE
  gw_owner text;
  gw_table text;
BEGIN
  IF to_regnamespace('graphile_worker') IS NULL THEN
    RAISE WARNING 'graphile_worker schema not found; run `node dist/cli.js migrate` as the owner first, then re-run this script';
  ELSE
    GRANT USAGE ON SCHEMA graphile_worker TO mc_app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO mc_app_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA graphile_worker TO mc_app_runtime;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO mc_app_runtime;

    SELECT pg_get_userbyid(nspowner) INTO gw_owner
    FROM pg_namespace WHERE nspname = 'graphile_worker';
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA graphile_worker '
      || 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mc_app_runtime',
      gw_owner);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA graphile_worker '
      || 'GRANT USAGE, SELECT ON SEQUENCES TO mc_app_runtime',
      gw_owner);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA graphile_worker '
      || 'GRANT EXECUTE ON FUNCTIONS TO mc_app_runtime',
      gw_owner);

    FOR gw_table IN
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'graphile_worker' AND c.relkind = 'r' AND c.relrowsecurity
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS mc_app_runtime_all ON graphile_worker.%I', gw_table);
      EXECUTE format(
        'CREATE POLICY mc_app_runtime_all ON graphile_worker.%I '
        || 'FOR ALL TO mc_app_runtime USING (true) WITH CHECK (true)',
        gw_table);
    END LOOP;
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 5. Lock down the tamper-evident tables. audit_events is append-only: the
--    runtime role keeps SELECT + INSERT (append a new audit row) but loses
--    UPDATE, DELETE, and TRUNCATE. instance is write-once and is seeded by the
--    owner migration (0001_init.sql: INSERT INTO instance DEFAULT VALUES); the
--    runtime role only ever does UPDATE(public_key_pem) (granted below) and never
--    INSERTs, so it loses INSERT, UPDATE, DELETE, and TRUNCATE here. Without
--    UPDATE/DELETE the role cannot rewrite history even if a logic sink is found;
--    not owning the tables, it also cannot ALTER TABLE ... DISABLE TRIGGER to
--    defeat the append-only guards. TRUNCATE is owner-only by default in Postgres,
--    but REVOKE it explicitly so intent is documented and a future broad GRANT
--    cannot silently re-enable it.
------------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM mc_app_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON instance FROM mc_app_runtime;

------------------------------------------------------------------------------
-- 6. One-time first-boot key publication. ensureInstanceKeys publishes the
--    instance Ed25519 public key exactly once (instance.public_key_pem: NULL ->
--    value) on the first key-bearing operation. The instance_immutable trigger
--    already makes that the ONLY permitted UPDATE (write-once, no rotation), so a
--    column-scoped UPDATE(public_key_pem) is safe to grant: the role can fill the
--    key once and nothing more. After publication, steady state needs only
--    SELECT. Pre-seeding instance.public_key_pem as the owner and skipping this
--    grant is an equally valid, tighter option (see SECURITY.md).
------------------------------------------------------------------------------
GRANT UPDATE (public_key_pem) ON instance TO mc_app_runtime;

------------------------------------------------------------------------------
-- 7. Future tables fail closed. ALTER DEFAULT PRIVILEGES is keyed to the role
--    that CREATES the future object (FOR ROLE ...), not to whoever runs this
--    script. Migrations are applied by the table owner, which may differ from the
--    (possibly superuser) role bootstrapping this hardening. So set the defaults
--    FOR each role that owns an existing application table -- i.e. the migration
--    owner(s). The default grant is SELECT, INSERT only: a future tamper-evident /
--    append-only table is then locked down by default and needs no extra REVOKE.
--    A future MUTABLE table needs an explicit GRANT UPDATE, DELETE line added here
--    after this loop. Existing tables already received full DML via the broad
--    grant in step 3; this default only governs tables added by later migrations.
------------------------------------------------------------------------------
DO $$
DECLARE
  owner_role text;
BEGIN
  FOR owner_role IN
    SELECT DISTINCT pg_get_userbyid(c.relowner)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
      || 'GRANT SELECT, INSERT ON TABLES TO mc_app_runtime',
      owner_role);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
      || 'GRANT USAGE, SELECT ON SEQUENCES TO mc_app_runtime',
      owner_role);
  END LOOP;
END
$$;

------------------------------------------------------------------------------
-- 8. Final precondition. The CREATE ROLE above pins NOSUPERUSER/NOINHERIT, but
--    those flags only apply at creation and the role may pre-exist (roles are
--    cluster-global), so a stale or hand-edited mc_app_runtime could already be a
--    superuser or a member of a table-owning role. Either would let it SET ROLE to
--    an owner and ALTER TABLE ... DISABLE TRIGGER, voiding the whole guarantee.
--    Fail loudly here rather than hand back a role that silently does not enforce.
------------------------------------------------------------------------------
DO $$
DECLARE
  bad_owner text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_app_runtime' AND rolsuper) THEN
    RAISE EXCEPTION 'mc_app_runtime is a superuser; it could bypass the audit triggers. Recreate it NOSUPERUSER.';
  END IF;

  SELECT DISTINCT pg_get_userbyid(c.relowner) INTO bad_owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND pg_has_role('mc_app_runtime', c.relowner, 'MEMBER')
    AND pg_get_userbyid(c.relowner) <> 'mc_app_runtime'
  LIMIT 1;
  IF bad_owner IS NOT NULL THEN
    RAISE EXCEPTION 'mc_app_runtime is a member of table-owning role %; it could SET ROLE and disable the audit triggers. Revoke that membership.', bad_owner;
  END IF;
END
$$;

------------------------------------------------------------------------------
-- Done. Verify with:
--   \dp audit_events instance         -- runtime role should show r/a only on these
--   SELECT has_table_privilege('mc_app_runtime', 'audit_events', 'UPDATE'); -- f
--   SELECT has_table_privilege('mc_app_runtime', 'audit_events', 'INSERT'); -- t
------------------------------------------------------------------------------
