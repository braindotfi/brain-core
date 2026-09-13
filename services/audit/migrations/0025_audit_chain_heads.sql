-- Authoritative per-tenant audit chain head.
--
-- The audit_events timestamp and random ULID order is not a chain-ordering
-- contract. The head row is the only source used by new emitters. The trigger
-- keeps the head current for the previous application revision during rolling
-- deployment and rejects stale predecessor writes.

CREATE TABLE audit_chain_heads (
  tenant_id         TEXT PRIMARY KEY,
  head_event_id     TEXT,
  head_event_hash   BYTEA,
  sequence          BIGINT NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (sequence = 0 AND head_event_id IS NULL AND head_event_hash IS NULL)
    OR
    (sequence > 0 AND head_event_id IS NOT NULL AND head_event_hash IS NOT NULL)
  )
);

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_chain_heads_tenant_read
  ON audit_chain_heads FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY audit_chain_heads_tenant_insert
  ON audit_chain_heads FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE OR REPLACE FUNCTION advance_audit_chain_head()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  changed_sequence BIGINT;
  event_count BIGINT;
  predecessor_exists BOOLEAN;
  successor_count BIGINT;
  head_exists BOOLEAN;
BEGIN
  -- Normal path: compare and swap the authoritative head. New emitters hold
  -- the tenant advisory lock before reading the head, while this predicate is
  -- the database-owned guard for every insert path.
  EXECUTE format(
    'UPDATE %I.audit_chain_heads '
    'SET head_event_id = $1, head_event_hash = $2, sequence = sequence + 1, '
    'updated_at = clock_timestamp() '
    'WHERE tenant_id = $3 AND head_event_hash IS NOT DISTINCT FROM $4 '
    'RETURNING sequence',
    TG_TABLE_SCHEMA
  ) INTO changed_sequence
    USING NEW.id, NEW.event_hash, NEW.tenant_id, NEW.prev_event_hash;

  IF changed_sequence IS NOT NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I.audit_chain_heads WHERE tenant_id = $1)',
    TG_TABLE_SCHEMA
  ) INTO head_exists USING NEW.tenant_id;

  IF head_exists THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'audit event predecessor does not match authoritative tenant chain head';
  END IF;

  -- Compatibility path for the brief interval after this trigger is installed
  -- and before the online head backfill completes. The inserted event is
  -- already visible because this is an AFTER INSERT trigger.
  EXECUTE format(
    'SELECT count(*) FROM %I.audit_events WHERE tenant_id = $1',
    TG_TABLE_SCHEMA
  ) INTO event_count USING NEW.tenant_id;

  IF NEW.prev_event_hash IS NULL THEN
    IF event_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'audit genesis insert is invalid without an authoritative tenant chain head';
    END IF;
  ELSE
    EXECUTE format(
      'SELECT EXISTS ('
      'SELECT 1 FROM %I.audit_events '
      'WHERE tenant_id = $1 AND event_hash = $2)',
      TG_TABLE_SCHEMA
    ) INTO predecessor_exists USING NEW.tenant_id, NEW.prev_event_hash;
    EXECUTE format(
      'SELECT count(*) FROM %I.audit_events '
      'WHERE tenant_id = $1 AND prev_event_hash = $2',
      TG_TABLE_SCHEMA
    ) INTO successor_count USING NEW.tenant_id, NEW.prev_event_hash;

    IF NOT predecessor_exists OR successor_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'audit successor insert is invalid without an authoritative tenant chain head';
    END IF;
  END IF;

  EXECUTE format(
    'INSERT INTO %I.audit_chain_heads '
    '(tenant_id, head_event_id, head_event_hash, sequence, updated_at) '
    'VALUES ($1, $2, $3, $4, clock_timestamp()) '
    'ON CONFLICT (tenant_id) DO NOTHING RETURNING sequence',
    TG_TABLE_SCHEMA
  ) INTO changed_sequence
    USING NEW.tenant_id, NEW.id, NEW.event_hash, event_count;

  IF changed_sequence IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- A non-cooperating concurrent insert may have initialized the row first.
  -- Retry the same compare and swap once, then fail closed.
  EXECUTE format(
    'UPDATE %I.audit_chain_heads '
    'SET head_event_id = $1, head_event_hash = $2, sequence = sequence + 1, '
    'updated_at = clock_timestamp() '
    'WHERE tenant_id = $3 AND head_event_hash IS NOT DISTINCT FROM $4 '
    'RETURNING sequence',
    TG_TABLE_SCHEMA
  ) INTO changed_sequence
    USING NEW.id, NEW.event_hash, NEW.tenant_id, NEW.prev_event_hash;

  IF changed_sequence IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'audit event lost authoritative tenant chain head race';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION advance_audit_chain_head() FROM PUBLIC;

CREATE TRIGGER audit_events_advance_chain_head
AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION advance_audit_chain_head();
