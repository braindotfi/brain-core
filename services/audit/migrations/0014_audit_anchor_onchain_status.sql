-- Anchor publisher lifecycle status (root-cause fix, 2026-06-09).
--
-- The publisher recorded only onchain_tx_hash (NULL until persisted). It could
-- not distinguish "broadcast in flight / never landed" from "the on-chain
-- anchor() reverted (RootAlreadyPublished, §5.3) and must NEVER be retried".
-- Without that, a window whose root was already anchored on-chain — but whose
-- tx-hash write was lost (broadcaster threw on the receipt wait, or a restart) —
-- got re-broadcast every cycle, reverting on-chain and burning nonces/ETH.
--
-- onchain_status makes the lifecycle explicit and gives the publisher loop and
-- the orphan reconciler a terminal state to skip:
--   pending   — row inserted, broadcast not yet confirmed (default).
--   confirmed — tx mined with status=1 (AnchorPublished emitted); tx hash set.
--   reverted  — tx mined with status=0 (deterministic contract revert). Terminal:
--               the publisher and reconciler must not retry it.

ALTER TABLE audit_anchors
  ADD COLUMN IF NOT EXISTS onchain_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (onchain_status IN ('pending', 'confirmed', 'reverted'));

-- Backfill: any pre-existing row that already carries a tx hash is confirmed.
UPDATE audit_anchors SET onchain_status = 'confirmed'
  WHERE onchain_tx_hash IS NOT NULL AND onchain_status <> 'confirmed';

-- The orphan reconciler scans (onchain_tx_hash IS NULL AND onchain_status <>
-- 'reverted'); index that hot path.
CREATE INDEX IF NOT EXISTS idx_audit_anchors_unconfirmed
  ON audit_anchors (created_at)
  WHERE onchain_tx_hash IS NULL AND onchain_status <> 'reverted';
