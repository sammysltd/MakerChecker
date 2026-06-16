-- The single instance row anchors the audit chain: instance.id derives the
-- genesis prev_hash, and public_key_pem is the export signing identity. It must
-- be as immutable as the governed tables (skills, flow_versions) — design
-- principle "nothing edited in place". Without this, the row could be re-rooted
-- (changing id rebases the whole chain's genesis) or its key silently swapped.
--
-- The ONLY permitted write after the initial row exists is the one-time
-- publication of public_key_pem (NULL -> value), which ensureInstanceKeys does
-- on first boot. id may never change; a set public_key_pem may never change;
-- the row may never be deleted.
--
-- Like the audit_events triggers, this binds at the table level and applies to
-- any connection. (It does not defend against a table OWNER disabling it; that
-- is the Layer-2 non-owner-role hardening described in SECURITY.md.)
CREATE FUNCTION instance_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'instance row is immutable; it cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'instance.id is immutable (it anchors the audit chain genesis)';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'instance.created_at is immutable';
  END IF;
  IF OLD.public_key_pem IS NOT NULL AND NEW.public_key_pem IS DISTINCT FROM OLD.public_key_pem THEN
    RAISE EXCEPTION 'instance.public_key_pem is write-once; the signing key cannot be rotated in place';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER instance_immutable_guard
  BEFORE UPDATE OR DELETE ON instance
  FOR EACH ROW EXECUTE FUNCTION instance_immutable();

-- TRUNCATE bypasses row-level BEFORE DELETE triggers, so it would otherwise wipe
-- the row (and a re-INSERT would mint a new id, re-rooting the chain genesis).
-- audit_events guards TRUNCATE the same way; instance must too.
CREATE FUNCTION instance_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'instance row is immutable; it cannot be truncated';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER instance_no_truncate_guard
  BEFORE TRUNCATE ON instance
  FOR EACH STATEMENT EXECUTE FUNCTION instance_no_truncate();

-- Single-row table: reject a SECOND row. The legitimate row is inserted by
-- 0001 before this trigger exists; afterwards any INSERT (e.g. an attacker
-- adding a second instance so `SELECT id FROM instance LIMIT 1` returns a
-- chosen genesis) is rejected.
CREATE FUNCTION instance_single_row() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM instance) > 0 THEN
    RAISE EXCEPTION 'instance is a single-row table; a second row is not allowed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER instance_single_row_guard
  BEFORE INSERT ON instance
  FOR EACH ROW EXECUTE FUNCTION instance_single_row();
