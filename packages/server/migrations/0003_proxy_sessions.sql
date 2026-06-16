-- Proxy sessions: governance middleware for externally-orchestrated agents.
-- Teams keep their existing framework (LangGraph, CrewAI, Claude Agent SDK,
-- anything) as the executor; MakerChecker is the authorization checkpoint and
-- the evidentiary record. A session groups the checks of one external run so
-- SoD can be evaluated across everything that already acted in it.

CREATE TABLE proxy_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  external_ref text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- One row per authorization check, allowed AND denied: the action ledger of a
-- session. role_id_snapshot freezes the agent's role at check time, so later
-- role reassignment cannot rewrite who acted as what (same semantics as
-- step_runs.role_id_snapshot). skill_id is nullable because denied checks may
-- reference skills that do not exist; skill_ref preserves what was asked for.
CREATE TABLE proxy_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES proxy_sessions(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  role_id_snapshot uuid NOT NULL REFERENCES roles(id),
  skill_id uuid REFERENCES skills(id),
  skill_ref text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allowed', 'denied')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proxy_actions_session_idx ON proxy_actions (session_id);
