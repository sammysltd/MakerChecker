-- n-of-m named approvals (M13). Each individual human decision on an approval
-- gate becomes a first-class, append-only row; the gate resolves when the
-- approved count reaches approvals.required_approvals, and any single
-- rejection resolves it immediately. The approvals row keeps its terminal
-- status + last decider for backwards compatibility; approval_decisions is
-- the per-decision ledger the audit chain corroborates.

CREATE TABLE approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL REFERENCES approvals(id),
  decided_by_user_id uuid REFERENCES users(id),
  decided_by_label text,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_decisions_approval_idx ON approval_decisions (approval_id);

-- The same authenticated user may decide a given approval at most once.
-- Partial: legacy/unauthenticated decisions carry no user id and are exempt
-- (they only ever occur on single-approval gates, which resolve immediately).
CREATE UNIQUE INDEX approval_decisions_one_decision_per_user_idx
  ON approval_decisions (approval_id, decided_by_user_id)
  WHERE decided_by_user_id IS NOT NULL;

ALTER TABLE approvals ADD COLUMN required_approvals integer NOT NULL DEFAULT 1;
