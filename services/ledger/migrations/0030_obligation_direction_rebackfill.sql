-- Brain Ledger -- obligation direction RE-backfill + data-quality report.
--
-- Codex 2026-06-05 review P2 (companion to the creation-time direction gate in
-- PaymentIntentService). 0029 added `ledger_obligations.direction` and
-- backfilled it ONCE from the counterparty type (vendor -> payable, customer ->
-- receivable, else NULL). Since then a direction can still be NULL because:
--   1. the counterparty was neither vendor nor customer at 0029's backfill
--      (bank / partner / internal) -- genuinely underivable;
--   2. an obligation was written via a path that omits direction
--      (upsertObligationRow takes it as OPTIONAL and defaults NULL; only the
--      doc_obligation_v1 extractor sets it today); or
--   3. a counterparty's type was CORRECTED to vendor/customer AFTER 0029 ran,
--      so the row is NOW derivable but stayed NULL (the one-time backfill does
--      not re-run).
--
-- The creation-time gate refuses a NEW obligation-linked PaymentIntent whose
-- obligation has a NULL/receivable direction, so a stale NULL on a row that is
-- actually a payable would wrongly block legitimate payments. This migration
-- re-derives direction for every still-NULL row from the CURRENT counterparty
-- type (idempotent: it only fills NULLs, never overwrites an existing value),
-- then RAISEs a NOTICE summarising how many it backfilled and how many remain
-- NULL, grouped by counterparty type -- the data-quality report at migrate
-- time. Anything left NULL is a genuinely non-vendor/customer obligation an
-- operator must classify (see docs/obligation-direction-data-quality.md for the
-- standing monitoring query).
--
-- Forward-compatible and safe to re-apply: WHERE o.direction IS NULL means a
-- row that already has a direction is never touched.

BEGIN;

-- Idempotent re-derivation from the current counterparty type. Identical shape
-- to 0029's backfill; re-running it catches rows that became derivable since.
UPDATE ledger_obligations o
   SET direction = CASE c.type
                     WHEN 'vendor'   THEN 'payable'
                     WHEN 'customer' THEN 'receivable'
                     ELSE NULL
                   END
  FROM ledger_counterparties c
 WHERE o.counterparty_id = c.id
   AND o.direction IS NULL
   AND c.type IN ('vendor', 'customer');

-- Data-quality report: how many obligations still have an unknown direction,
-- and which counterparty type they hang off, so the gap is visible in the
-- migrate log. Remaining NULLs are legitimately underivable (the counterparty
-- is not an AP/AR party) and need an operator decision, not an automatic guess.
DO $$
DECLARE
  remaining_null BIGINT;
  rec RECORD;
BEGIN
  SELECT count(*) INTO remaining_null
    FROM ledger_obligations
   WHERE direction IS NULL;

  RAISE NOTICE 'obligation direction re-backfill complete; % obligation(s) still have NULL direction', remaining_null;

  FOR rec IN
    SELECT COALESCE(c.type, '(no counterparty)') AS cp_type, count(*) AS n
      FROM ledger_obligations o
      LEFT JOIN ledger_counterparties c ON c.id = o.counterparty_id
     WHERE o.direction IS NULL
     GROUP BY COALESCE(c.type, '(no counterparty)')
     ORDER BY n DESC
  LOOP
    RAISE NOTICE '  remaining NULL-direction obligations with counterparty type %: %', rec.cp_type, rec.n;
  END LOOP;
END $$;

COMMIT;
