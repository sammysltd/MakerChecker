-- MakerChecker initial schema.
-- Governed entities are never edited in place: revocation/deprecation sets a
-- column; history survives. Run-state tables are mutable working state whose
-- every transition also emits an audit event (in the same transaction).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Single-row instance identity; created here so the audit genesis hash and
-- export bundles have a stable instance_id from the first boot.
CREATE TABLE instance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key_pem text,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO instance DEFAULT VALUES;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  limits jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version integer NOT NULL,
  description text NOT NULL DEFAULT '',
  input_schema jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  implementation jsonb NOT NULL,        -- {type:'mcp'|'http'|'local', ...config}
  risk_tier text NOT NULL CHECK (risk_tier IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'deprecated')),
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

-- Published skills are immutable; the only permitted change is deprecation.
CREATE FUNCTION skills_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'deprecated'
     AND OLD.status = 'published'
     AND NEW.id = OLD.id
     AND NEW.name = OLD.name
     AND NEW.version = OLD.version
     AND NEW.description = OLD.description
     AND NEW.input_schema = OLD.input_schema
     AND NEW.output_schema = OLD.output_schema
     AND NEW.implementation = OLD.implementation
     AND NEW.risk_tier = OLD.risk_tier
     AND NEW.created_by_user_id IS NOT DISTINCT FROM OLD.created_by_user_id
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'skills are immutable once published; only status -> deprecated is allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER skills_immutable_guard
  BEFORE UPDATE ON skills
  FOR EACH ROW EXECUTE FUNCTION skills_immutable();

-- Grants are append-only facts: revoke sets revoked_at, never DELETE.
CREATE TABLE role_skill_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES roles(id),
  skill_id uuid NOT NULL REFERENCES skills(id),
  granted_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES users(id)
);
CREATE INDEX role_skill_grants_active_idx
  ON role_skill_grants (role_id, skill_id) WHERE revoked_at IS NULL;

-- Symmetric pairs; enforce canonical ordering so (A,B) and (B,A) can't both exist.
CREATE TABLE sod_constraints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_a_id uuid NOT NULL REFERENCES roles(id),
  role_b_id uuid NOT NULL REFERENCES roles(id),
  scope text NOT NULL DEFAULT 'flow_run',
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (role_a_id < role_b_id)
);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  role_id uuid NOT NULL REFERENCES roles(id),
  model_config jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES flows(id),
  version integer NOT NULL,
  definition jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);

-- Published flow versions allow only status -> archived.
CREATE FUNCTION flow_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;  -- drafts are freely editable
  END IF;
  IF OLD.status = 'published'
     AND NEW.status = 'archived'
     AND NEW.id = OLD.id
     AND NEW.flow_id = OLD.flow_id
     AND NEW.version = OLD.version
     AND NEW.definition = OLD.definition
     AND NEW.created_by_user_id IS NOT DISTINCT FROM OLD.created_by_user_id
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published flow versions are immutable; only status -> archived is allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER flow_versions_immutable_guard
  BEFORE UPDATE ON flow_versions
  FOR EACH ROW EXECUTE FUNCTION flow_versions_immutable();

CREATE TABLE flow_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES flows(id),
  type text NOT NULL CHECK (type IN ('cron', 'event', 'manual')),
  config jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Run-state tables (mutable; the audit chain is the canonical record).

CREATE TABLE flow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_version_id uuid NOT NULL REFERENCES flow_versions(id),
  trigger_id uuid REFERENCES flow_triggers(id),
  triggered_by jsonb NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'timed_out')),
  failure_reason text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE step_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES flow_runs(id),
  step_index integer NOT NULL,
  step_key text NOT NULL,
  agent_id uuid REFERENCES agents(id),
  role_id_snapshot uuid REFERENCES roles(id),  -- frozen at execution for SoD checks
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'running', 'completed', 'failed', 'timed_out')),
  attempt integer NOT NULL DEFAULT 1,
  input jsonb,
  output jsonb,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX step_runs_run_idx ON step_runs (run_id, step_index);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES flow_runs(id),
  step_run_id uuid REFERENCES step_runs(id),
  step_index integer NOT NULL,
  step_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  reason text
);

-- The audit chain. Append-only, hash-chained, single-writer (advisory lock in
-- the AuditWriter). seq is storage order only and is excluded from the hash:
-- identity columns leave gaps on aborted transactions; chain order is defined
-- solely by prev_hash linkage.
CREATE TABLE audit_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  -- ISO 8601 UTC text, hashed byte-for-byte. Stored as text so verification is
  -- exact (timestamptz round-trips reformat); fixed-format UTC ISO strings sort
  -- lexicographically in chronological order, so a plain index suffices.
  occurred_at text NOT NULL,
  actor jsonb NOT NULL,
  event_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  run_id uuid,
  payload jsonb NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL UNIQUE
);
CREATE INDEX audit_events_run_idx ON audit_events (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);

-- Append-only guards.
--   Layer 1 (shipped, default): BEFORE UPDATE/DELETE/TRUNCATE triggers reject
--     any in-band edit. NOTE: a table OWNER may DISABLE its own triggers, so
--     this layer is only fully effective when the app connects as a NON-owner
--     role (Layer 2). The single-role docker default does not get that.
--   Layer 2 (recommended deployment hardening, NOT default): run the server as
--     a role that holds only INSERT/SELECT on audit_events and does not own it,
--     so it cannot DISABLE TRIGGER or UPDATE/DELETE. See SECURITY.md.
--   Layer 3 (the hash chain): detects out-of-band MUTATION and middle-row
--     deletion on read via verify. It does NOT by itself detect tail-truncation
--     or full rollback (the live chain has no end anchor) — that requires
--     comparing against an externally-retained signed export. See SECURITY.md.
CREATE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
