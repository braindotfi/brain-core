-- Preflight cleanup for ledger direct-write dedup constraints.
--
-- The migration runner records content hashes for applied migrations, so the
-- already-merged 0044 migration cannot be edited safely. This migration sorts
-- before 0044 and makes its partial unique indexes self-healing for tenants
-- that already contain rows from the old select-then-insert race.

BEGIN;

ALTER TABLE ledger_obligations
  ADD COLUMN IF NOT EXISTS external_key TEXT;

DROP TABLE IF EXISTS ledger_dedup_counterparty_map;
CREATE TEMP TABLE ledger_dedup_counterparty_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id AS loser_id,
    FIRST_VALUE(id) OVER (
      PARTITION BY owner_id, normalized_name, type
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS survivor_id,
    ROW_NUMBER() OVER (
      PARTITION BY owner_id, normalized_name, type
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM ledger_counterparties
  WHERE normalized_name IS NOT NULL
    AND canonical_counterparty_id IS NULL
)
SELECT loser_id, survivor_id
FROM ranked
WHERE rn > 1;

CREATE INDEX ledger_dedup_counterparty_map_loser_idx
  ON ledger_dedup_counterparty_map (loser_id);
CREATE INDEX ledger_dedup_counterparty_map_survivor_idx
  ON ledger_dedup_counterparty_map (survivor_id);

WITH target AS (
  SELECT DISTINCT survivor_id
  FROM ledger_dedup_counterparty_map
),
members AS (
  SELECT t.survivor_id, c.*
  FROM target t
  JOIN ledger_counterparties c
    ON c.id = t.survivor_id
    OR c.id IN (
      SELECT loser_id
      FROM ledger_dedup_counterparty_map m
      WHERE m.survivor_id = t.survivor_id
    )
),
merged AS (
  SELECT
    t.survivor_id,
    ARRAY(
      SELECT DISTINCT alias
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.aliases, ARRAY[]::text[])) AS alias
      WHERE m.survivor_id = t.survivor_id
      ORDER BY alias
    ) AS aliases,
    ARRAY(
      SELECT DISTINCT account_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.linked_accounts, ARRAY[]::text[])) AS account_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY account_id
    ) AS linked_accounts,
    ARRAY(
      SELECT DISTINCT source_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.source_ids, ARRAY[]::text[])) AS source_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY source_id
    ) AS source_ids,
    ARRAY(
      SELECT DISTINCT evidence_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.evidence_ids, ARRAY[]::text[])) AS evidence_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY evidence_id
    ) AS evidence_ids,
    COALESCE((
      SELECT jsonb_object_agg(meta.key, meta.value ORDER BY m.created_at ASC NULLS LAST, m.id ASC)
      FROM members m
      CROSS JOIN LATERAL jsonb_each(COALESCE(m.metadata, '{}'::jsonb)) AS meta(key, value)
      WHERE m.survivor_id = t.survivor_id
        AND m.id <> t.survivor_id
    ), '{}'::jsonb) AS loser_metadata,
    (
      SELECT MAX(m.confidence)
      FROM members m
      WHERE m.survivor_id = t.survivor_id
    ) AS max_confidence,
    (
      SELECT MAX(m.updated_at)
      FROM members m
      WHERE m.survivor_id = t.survivor_id
    ) AS max_updated_at
  FROM target t
  GROUP BY t.survivor_id
)
UPDATE ledger_counterparties survivor
SET aliases = merged.aliases,
    linked_accounts = merged.linked_accounts,
    source_ids = merged.source_ids,
    evidence_ids = merged.evidence_ids,
    metadata = merged.loser_metadata || COALESCE(survivor.metadata, '{}'::jsonb),
    confidence = GREATEST(survivor.confidence, merged.max_confidence),
    updated_at = GREATEST(survivor.updated_at, merged.max_updated_at)
FROM merged
WHERE survivor.id = merged.survivor_id;

UPDATE ledger_obligations o
SET counterparty_id = m.survivor_id
FROM ledger_dedup_counterparty_map m
WHERE o.counterparty_id = m.loser_id;

UPDATE ledger_payment_intents pi
SET destination_counterparty_id = m.survivor_id
FROM ledger_dedup_counterparty_map m
WHERE pi.destination_counterparty_id = m.loser_id;

UPDATE ledger_transactions tx
SET counterparty_id = m.survivor_id
FROM ledger_dedup_counterparty_map m
WHERE tx.counterparty_id = m.loser_id;

UPDATE ledger_counterparty_payment_instructions cpi
SET counterparty_id = m.survivor_id
FROM ledger_dedup_counterparty_map m
WHERE cpi.counterparty_id = m.loser_id;

DROP TABLE IF EXISTS ledger_dedup_invoice_map;
CREATE TEMP TABLE ledger_dedup_invoice_map ON COMMIT DROP AS
WITH canonical AS (
  SELECT
    i.id,
    COALESCE(m.survivor_id, i.counterparty_id) AS canonical_counterparty_id,
    FIRST_VALUE(i.id) OVER (
      PARTITION BY i.owner_id, COALESCE(m.survivor_id, i.counterparty_id), i.invoice_number
      ORDER BY i.created_at ASC NULLS LAST, i.id ASC
    ) AS survivor_id,
    ROW_NUMBER() OVER (
      PARTITION BY i.owner_id, COALESCE(m.survivor_id, i.counterparty_id), i.invoice_number
      ORDER BY i.created_at ASC NULLS LAST, i.id ASC
    ) AS rn
  FROM ledger_invoices i
  LEFT JOIN ledger_dedup_counterparty_map m ON m.loser_id = i.counterparty_id
)
SELECT id AS loser_id, survivor_id, canonical_counterparty_id
FROM canonical
WHERE rn > 1;

CREATE INDEX ledger_dedup_invoice_map_loser_idx
  ON ledger_dedup_invoice_map (loser_id);

WITH target AS (
  SELECT DISTINCT survivor_id
  FROM ledger_dedup_invoice_map
),
members AS (
  SELECT t.survivor_id, i.*
  FROM target t
  JOIN ledger_invoices i
    ON i.id = t.survivor_id
    OR i.id IN (
      SELECT loser_id
      FROM ledger_dedup_invoice_map m
      WHERE m.survivor_id = t.survivor_id
    )
),
merged AS (
  SELECT
    t.survivor_id,
    ARRAY(
      SELECT DISTINCT document_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.linked_document_ids, ARRAY[]::text[])) AS document_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY document_id
    ) AS linked_document_ids,
    ARRAY(
      SELECT DISTINCT transaction_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.linked_transaction_ids, ARRAY[]::text[])) AS transaction_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY transaction_id
    ) AS linked_transaction_ids,
    ARRAY(
      SELECT DISTINCT source_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.source_ids, ARRAY[]::text[])) AS source_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY source_id
    ) AS source_ids,
    ARRAY(
      SELECT DISTINCT evidence_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.evidence_ids, ARRAY[]::text[])) AS evidence_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY evidence_id
    ) AS evidence_ids,
    COALESCE((
      SELECT jsonb_object_agg(meta.key, meta.value ORDER BY m.created_at ASC NULLS LAST, m.id ASC)
      FROM members m
      CROSS JOIN LATERAL jsonb_each(COALESCE(m.metadata, '{}'::jsonb)) AS meta(key, value)
      WHERE m.survivor_id = t.survivor_id
        AND m.id <> t.survivor_id
    ), '{}'::jsonb) AS loser_metadata,
    (
      SELECT MAX(m.amount_paid)
      FROM members m
      WHERE m.survivor_id = t.survivor_id
    ) AS max_amount_paid,
    (
      SELECT MAX(m.confidence)
      FROM members m
      WHERE m.survivor_id = t.survivor_id
    ) AS max_confidence,
    (
      SELECT MAX(m.updated_at)
      FROM members m
      WHERE m.survivor_id = t.survivor_id
    ) AS max_updated_at
  FROM target t
  GROUP BY t.survivor_id
)
UPDATE ledger_invoices survivor
SET linked_document_ids = merged.linked_document_ids,
    linked_transaction_ids = merged.linked_transaction_ids,
    source_ids = merged.source_ids,
    evidence_ids = merged.evidence_ids,
    metadata = merged.loser_metadata || COALESCE(survivor.metadata, '{}'::jsonb),
    amount_paid = GREATEST(survivor.amount_paid, merged.max_amount_paid),
    confidence = GREATEST(survivor.confidence, merged.max_confidence),
    updated_at = GREATEST(survivor.updated_at, merged.max_updated_at)
FROM merged
WHERE survivor.id = merged.survivor_id;

UPDATE ledger_payment_intents pi
SET invoice_id = m.survivor_id
FROM ledger_dedup_invoice_map m
WHERE pi.invoice_id = m.loser_id;

DELETE FROM ledger_invoices i
USING ledger_dedup_invoice_map m
WHERE i.id = m.loser_id;

UPDATE ledger_invoices i
SET counterparty_id = m.survivor_id
FROM ledger_dedup_counterparty_map m
WHERE i.counterparty_id = m.loser_id;

DROP TABLE IF EXISTS ledger_dedup_obligation_map;
CREATE TEMP TABLE ledger_dedup_obligation_map ON COMMIT DROP AS
WITH ranked_external AS (
  SELECT
    id AS loser_id,
    FIRST_VALUE(id) OVER (
      PARTITION BY owner_id, external_key
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS survivor_id,
    ROW_NUMBER() OVER (
      PARTITION BY owner_id, external_key
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM ledger_obligations
  WHERE external_key IS NOT NULL
),
ranked_legacy AS (
  SELECT
    id AS loser_id,
    FIRST_VALUE(id) OVER (
      PARTITION BY owner_id, counterparty_id, type, amount_due, currency, due_date
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS survivor_id,
    ROW_NUMBER() OVER (
      PARTITION BY owner_id, counterparty_id, type, amount_due, currency, due_date
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM ledger_obligations
  WHERE external_key IS NULL
)
SELECT loser_id, survivor_id
FROM ranked_external
WHERE rn > 1
UNION ALL
SELECT loser_id, survivor_id
FROM ranked_legacy
WHERE rn > 1;

CREATE INDEX ledger_dedup_obligation_map_loser_idx
  ON ledger_dedup_obligation_map (loser_id);
CREATE INDEX ledger_dedup_obligation_map_survivor_idx
  ON ledger_dedup_obligation_map (survivor_id);

WITH target AS (
  SELECT DISTINCT survivor_id
  FROM ledger_dedup_obligation_map
),
members AS (
  SELECT t.survivor_id, o.*
  FROM target t
  JOIN ledger_obligations o
    ON o.id = t.survivor_id
    OR o.id IN (
      SELECT loser_id
      FROM ledger_dedup_obligation_map m
      WHERE m.survivor_id = t.survivor_id
    )
),
merged AS (
  SELECT
    t.survivor_id,
    ARRAY(
      SELECT DISTINCT transaction_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.linked_transaction_ids, ARRAY[]::text[])) AS transaction_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY transaction_id
    ) AS linked_transaction_ids,
    ARRAY(
      SELECT DISTINCT source_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.source_ids, ARRAY[]::text[])) AS source_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY source_id
    ) AS source_ids,
    ARRAY(
      SELECT DISTINCT evidence_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.evidence_ids, ARRAY[]::text[])) AS evidence_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY evidence_id
    ) AS evidence_ids,
    COALESCE((
      SELECT jsonb_object_agg(meta.key, meta.value ORDER BY m.created_at ASC NULLS LAST, m.id ASC)
      FROM members m
      CROSS JOIN LATERAL jsonb_each(COALESCE(m.metadata, '{}'::jsonb)) AS meta(key, value)
      WHERE m.survivor_id = t.survivor_id
        AND m.id <> t.survivor_id
    ), '{}'::jsonb) AS loser_metadata,
    (
      SELECT MAX(m.confidence)
      FROM members m
      WHERE m.survivor_id = t.survivor_id
    ) AS max_confidence,
    (
      SELECT MAX(m.updated_at)
      FROM members m
      WHERE m.survivor_id = t.survivor_id
    ) AS max_updated_at
  FROM target t
  GROUP BY t.survivor_id
)
UPDATE ledger_obligations survivor
SET linked_transaction_ids = merged.linked_transaction_ids,
    source_ids = merged.source_ids,
    evidence_ids = merged.evidence_ids,
    metadata = merged.loser_metadata || COALESCE(survivor.metadata, '{}'::jsonb),
    confidence = GREATEST(survivor.confidence, merged.max_confidence),
    updated_at = GREATEST(survivor.updated_at, merged.max_updated_at)
FROM merged
WHERE survivor.id = merged.survivor_id;

UPDATE ledger_payment_intents pi
SET obligation_id = m.survivor_id
FROM ledger_dedup_obligation_map m
WHERE pi.obligation_id = m.loser_id;

UPDATE ledger_documents d
SET linked_obligation_ids = ARRAY(
  SELECT DISTINCT COALESCE(m.survivor_id, obligation_id)
  FROM unnest(COALESCE(d.linked_obligation_ids, ARRAY[]::text[])) AS obligation_id
  LEFT JOIN ledger_dedup_obligation_map m ON m.loser_id = obligation_id
  ORDER BY COALESCE(m.survivor_id, obligation_id)
)
WHERE EXISTS (
  SELECT 1
  FROM unnest(COALESCE(d.linked_obligation_ids, ARRAY[]::text[])) AS obligation_id
  JOIN ledger_dedup_obligation_map m ON m.loser_id = obligation_id
);

DROP TABLE IF EXISTS ledger_dedup_entity_map;
CREATE TEMP TABLE ledger_dedup_entity_map ON COMMIT DROP AS
SELECT 'counterparty'::text AS entity_type, loser_id, survivor_id
FROM ledger_dedup_counterparty_map
UNION ALL
SELECT 'obligation'::text AS entity_type, loser_id, survivor_id
FROM ledger_dedup_obligation_map;

CREATE INDEX ledger_dedup_entity_map_loser_idx
  ON ledger_dedup_entity_map (entity_type, loser_id);

DROP TABLE IF EXISTS ledger_dedup_match_map;
CREATE TEMP TABLE ledger_dedup_match_map ON COMMIT DROP AS
WITH canonical AS (
  SELECT
    r.id,
    r.owner_id,
    r.match_type,
    r.left_entity_type,
    COALESCE(lm.survivor_id, r.left_entity_id) AS canonical_left_entity_id,
    r.right_entity_type,
    COALESCE(rm.survivor_id, r.right_entity_id) AS canonical_right_entity_id,
    FIRST_VALUE(r.id) OVER (
      PARTITION BY
        r.owner_id,
        r.match_type,
        r.left_entity_type,
        COALESCE(lm.survivor_id, r.left_entity_id),
        r.right_entity_type,
        COALESCE(rm.survivor_id, r.right_entity_id)
      ORDER BY r.created_at ASC NULLS LAST, r.id ASC
    ) AS survivor_id,
    ROW_NUMBER() OVER (
      PARTITION BY
        r.owner_id,
        r.match_type,
        r.left_entity_type,
        COALESCE(lm.survivor_id, r.left_entity_id),
        r.right_entity_type,
        COALESCE(rm.survivor_id, r.right_entity_id)
      ORDER BY r.created_at ASC NULLS LAST, r.id ASC
    ) AS rn
  FROM ledger_reconciliation_matches r
  LEFT JOIN ledger_dedup_entity_map lm
    ON lm.entity_type = r.left_entity_type
   AND lm.loser_id = r.left_entity_id
  LEFT JOIN ledger_dedup_entity_map rm
    ON rm.entity_type = r.right_entity_type
   AND rm.loser_id = r.right_entity_id
)
SELECT id AS loser_id, survivor_id
FROM canonical
WHERE rn > 1;

CREATE INDEX ledger_dedup_match_map_loser_idx
  ON ledger_dedup_match_map (loser_id);

WITH target AS (
  SELECT DISTINCT survivor_id
  FROM ledger_dedup_match_map
),
members AS (
  SELECT t.survivor_id, r.*
  FROM target t
  JOIN ledger_reconciliation_matches r
    ON r.id = t.survivor_id
    OR r.id IN (
      SELECT loser_id
      FROM ledger_dedup_match_map m
      WHERE m.survivor_id = t.survivor_id
    )
),
merged AS (
  SELECT
    t.survivor_id,
    ARRAY(
      SELECT DISTINCT evidence_id
      FROM members m
      CROSS JOIN LATERAL unnest(COALESCE(m.evidence_ids, ARRAY[]::text[])) AS evidence_id
      WHERE m.survivor_id = t.survivor_id
      ORDER BY evidence_id
    ) AS evidence_ids,
    (
      SELECT MAX(m.confidence_score)
      FROM members m
      WHERE m.survivor_id = t.survivor_id
    ) AS max_confidence_score,
    (
      SELECT MAX(m.updated_at)
      FROM members m
      WHERE m.survivor_id = t.survivor_id
    ) AS max_updated_at
  FROM target t
  GROUP BY t.survivor_id
)
UPDATE ledger_reconciliation_matches survivor
SET evidence_ids = merged.evidence_ids,
    confidence_score = GREATEST(survivor.confidence_score, merged.max_confidence_score),
    updated_at = GREATEST(survivor.updated_at, merged.max_updated_at)
FROM merged
WHERE survivor.id = merged.survivor_id;

DELETE FROM ledger_reconciliation_matches r
USING ledger_dedup_match_map m
WHERE r.id = m.loser_id;

UPDATE ledger_reconciliation_matches r
SET left_entity_id = m.survivor_id
FROM ledger_dedup_entity_map m
WHERE r.left_entity_type = m.entity_type
  AND r.left_entity_id = m.loser_id;

UPDATE ledger_reconciliation_matches r
SET right_entity_id = m.survivor_id
FROM ledger_dedup_entity_map m
WHERE r.right_entity_type = m.entity_type
  AND r.right_entity_id = m.loser_id;

DELETE FROM ledger_obligations o
USING ledger_dedup_obligation_map m
WHERE o.id = m.loser_id;

DELETE FROM ledger_counterparties c
USING ledger_dedup_counterparty_map m
WHERE c.id = m.loser_id;

COMMIT;
