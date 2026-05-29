-- Populate ledger_counterparty_payment_instructions automatically on every
-- relevant counterparty change.
--
-- Trigger fires for INSERT and UPDATE on ledger_counterparties when the
-- payment-routing fields change: linked_accounts (off-chain bank/account
-- references) or onchain_address (the x402 / escrow payee). A row in the
-- history table is inserted with the prior and current hashes so the §6
-- gate check 11.5 rule 6 (destination_recently_changed) can detect a vendor
-- account swap inside the 24-hour fraud window.
--
-- prior_hash on INSERT is NULL (first record); on UPDATE it is the old
-- payment-instruction hash so the diff is reconstructable.
--
-- Triggers run inside the same transaction as the counterparty write, so the
-- history row is RLS-bound to the same owner_id as the source row. The
-- INSERT into the history table uses SECURITY INVOKER (default), so
-- existing tenant_isolation_write policy applies.

BEGIN;

CREATE OR REPLACE FUNCTION ledger_counterparty_payment_instructions_writer()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
DECLARE
  v_old_hash  TEXT;
  v_new_hash  TEXT;
  v_id        TEXT;
BEGIN
  -- Stable hash over the routing-relevant fields. ARRAY-to-TEXT cast is
  -- order-preserving in Postgres, so an array reorder counts as a change
  -- (acceptable: it is rare and re-orders matter for routing logic).
  v_new_hash := encode(
    digest(
      COALESCE(array_to_string(NEW.linked_accounts, ','), '') || '|' ||
      COALESCE(NEW.onchain_address, ''),
      'sha256'
    ),
    'hex'
  );

  IF TG_OP = 'UPDATE' THEN
    v_old_hash := encode(
      digest(
        COALESCE(array_to_string(OLD.linked_accounts, ','), '') || '|' ||
        COALESCE(OLD.onchain_address, ''),
        'sha256'
      ),
      'hex'
    );
    -- No-op when nothing routing-relevant changed.
    IF v_old_hash = v_new_hash THEN
      RETURN NEW;
    END IF;
  ELSE
    v_old_hash := NULL;
  END IF;

  -- Brain id shape: cpi_<ulid>. We use gen_random_uuid for the suffix here
  -- because a portable ulid generator is not available in the migration
  -- environment; the prefix marks the entity type for downstream readers.
  v_id := 'cpi_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO ledger_counterparty_payment_instructions (
    id, owner_id, counterparty_id, changed_at,
    prior_hash, current_hash, source_id, actor, created_at
  ) VALUES (
    v_id,
    NEW.owner_id,
    NEW.id,
    now(),
    v_old_hash,
    v_new_hash,
    NULL,                      -- source_id wiring is the writer's choice
    current_setting('app.actor', true),  -- ServiceCallContext stamps app.actor when set
    now()
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_counterparty_payment_instructions
  ON ledger_counterparties;

CREATE TRIGGER trg_ledger_counterparty_payment_instructions
  AFTER INSERT OR UPDATE OF linked_accounts, onchain_address
  ON ledger_counterparties
  FOR EACH ROW
  EXECUTE FUNCTION ledger_counterparty_payment_instructions_writer();

COMMENT ON FUNCTION ledger_counterparty_payment_instructions_writer() IS
  'Writes a payment-instruction history row whenever linked_accounts or onchain_address on ledger_counterparties changes. Source for §6 gate check 11.5 rule 6 (destination_recently_changed).';

COMMIT;
