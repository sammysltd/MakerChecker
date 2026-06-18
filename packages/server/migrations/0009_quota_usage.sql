-- Windowed quota accrual ledger. A per-skill quota (roles.limits.skills.<ref>
-- .quotas[]) accumulates a quantity — a named input field, or 1 per call — over
-- a time window that spans sessions and runs, denying when the running total
-- plus the next call would exceed the ceiling. One row per ALLOWED proxy action
-- that contributed; denied attempts never accrue, so the SUM reflects only what
-- was permitted. The running total for a window is a SUM over these rows filtered
-- by (agent, skill_ref, quota_key) and the window's time/session predicate.
--
-- amount is numeric (not integer) because a contribution may be a fractional
-- field value, not just a count. proxy_action_id ties each accrual to the action
-- it was authorized alongside (in the same transaction); session_id supports the
-- "session" window. occurred_at is the accrual instant the time windows truncate.

CREATE TABLE quota_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proxy_action_id uuid REFERENCES proxy_actions(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  session_id uuid REFERENCES proxy_sessions(id),
  skill_ref text NOT NULL,
  quota_key text NOT NULL,
  amount numeric NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- Serves the windowed SUM: lookup is by (agent, skill_ref, quota_key) with a
-- range/order on occurred_at for the day/week/month/lifetime windows.
CREATE INDEX quota_usage_lookup_idx
  ON quota_usage (agent_id, skill_ref, quota_key, occurred_at);
