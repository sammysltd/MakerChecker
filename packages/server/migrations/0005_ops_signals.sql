-- M14/M15 hardening + ops signals.
--
-- approvals.notified_overdue_at: set exactly once by the watchdog when a
-- pending approval has waited longer than MAKERCHECKER_APPROVAL_OVERDUE_MINUTES
-- (default 60). Guards the one-notification-per-approval guarantee: the
-- approval.overdue audit event and webhook fire only on the transition from
-- NULL, in the same transaction that sets the timestamp.

ALTER TABLE approvals ADD COLUMN notified_overdue_at timestamptz;
