-- Canonical projection log source-version tracking.
--
-- canonical_projection_log has raw_parsed_id TEXT PRIMARY KEY and recorded no
-- information about WHICH VERSION of the raw_parsed payload a log row's
-- projection actually consumed. The projector's pending gate
-- (PENDING_EXCLUSION in services/canonical/src/projectors/worker.ts)
-- permanently excludes any raw_parsed row that already has a log entry with
-- error IS NULL: a successful projection was treated as terminal forever.
-- Meanwhile raw_parsed rows are mutated in place on re-extraction
-- (repairParsedOutput bumps extracted, confidence, and extracted_at), and
-- insertParsed is idempotent on UNIQUE (raw_artifact_id, parser,
-- parser_version), so a corrected extraction can never create a new
-- raw_parsed row. Net effect: a corrected extraction was silently discarded
-- and the only recovery was an operator deleting the stale log row by hand.
--
-- This adds parsed_extracted_at: the extracted_at of the raw_parsed row a log
-- entry actually consumed. A log row is now terminal only for the payload
-- version it was written against; once raw_parsed.extracted_at moves past
-- what the log recorded, the row is pending again and the projector replays
-- it. Replay is safe: every canonical write upserts on (tenant_id,
-- source_system, source_natural_key), and journal lines are deleted and
-- replaced per entry, so re-projecting a corrected payload is idempotent.
--
-- Backfill (same migration as the column add, not a follow-up): every
-- existing log row is stamped with the extracted_at of the raw_parsed row it
-- points at. Without this, every historical log row would compare as
-- unversioned (NULL) against a real extracted_at and the projector would
-- re-project the entire history on first boot after this migration ships.
--
-- Orphans: a log row whose raw_parsed row has since been deleted (not merely
-- repaired) is left with parsed_extracted_at NULL by the backfill, since
-- there is no raw_parsed.extracted_at to copy. This is safe: every query that
-- uses the pending gate is driven FROM raw_parsed (rp), so a log row with no
-- matching raw_parsed row is never visited by the gate at all -- the NULL
-- never gets compared against anything.
--
-- Bootstrap ordering: migrations run in global {service}/{filename} order
-- (tools/migrate/src/discover.ts), so on a FRESH database canonical/0005 runs
-- before raw/0002 creates raw_parsed. The backfill is guarded with
-- to_regclass so it no-ops when raw_parsed does not exist yet -- correct,
-- since a fresh database has no log rows to backfill anyway.
--
-- FORCE ROW LEVEL SECURITY: canonical_projection_log forces RLS (migration
-- 0001), so under a non-superuser migration role the UPDATE would be scoped
-- by tenant_isolation's USING (tenant_id = current_setting('app.tenant_id',
-- true)) -- unset during a migration, so the predicate is NULL and the
-- UPDATE would silently touch zero rows. `row_security = off` makes a
-- non-bypassing role fail loudly (`ERROR: query would be affected by
-- row-level security policy`) instead of shipping a no-op backfill that
-- leaves every historical row NULL (and, under IS NOT DISTINCT FROM, forever
-- pending -- a full-history re-projection storm on first boot).
--
-- Lock scope: ADD COLUMN + the backfill share one ACCESS EXCLUSIVE-holding
-- transaction across the full table rewrite, blocking the running projector.
-- lock_timeout makes a deploy fail fast instead of stalling it.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

ALTER TABLE canonical_projection_log
  ADD COLUMN IF NOT EXISTS parsed_extracted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF to_regclass('public.raw_parsed') IS NOT NULL THEN
    UPDATE canonical_projection_log pl
       SET parsed_extracted_at = rp.extracted_at
      FROM raw_parsed rp
     WHERE rp.id = pl.raw_parsed_id
       AND pl.parsed_extracted_at IS NULL;
  END IF;
END $$;

COMMIT;
