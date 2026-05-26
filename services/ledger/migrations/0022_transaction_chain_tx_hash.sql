-- Record the on-chain transaction hash on ledger_transactions (v0.4 / RFC 0001).
-- The entity schema (schemas/entity/transaction.schema.json) already defines
-- chain_tx_hash, but the table never had the column. On-chain settlements (e.g.
-- a USDC transfer on Base) carry it as their on-chain proof, and the
-- onchain_settlement matcher requires it. Nullable; off-chain txs leave it null.
-- Forward-compatible (additive column).

BEGIN;

ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS chain_tx_hash TEXT;

ALTER TABLE ledger_transactions
  DROP CONSTRAINT IF EXISTS ledger_transactions_chain_tx_hash_check;

ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_chain_tx_hash_check
  CHECK (chain_tx_hash IS NULL OR chain_tx_hash ~ '^0x[a-fA-F0-9]{64}$');

COMMENT ON COLUMN ledger_transactions.chain_tx_hash IS
  'On-chain settlement tx hash (e.g. USDC transfer on Base); null for off-chain. RFC 0001.';

COMMIT;
