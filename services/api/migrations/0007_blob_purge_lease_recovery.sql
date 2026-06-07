-- RFC 0003 hardening (2026-06-07 review P1 #1): recover purge jobs abandoned by
-- a crashed worker.
--
-- The claim in 0006 only ever selected status IN ('pending','failed'). A worker
-- that exits after flipping a job to 'purging' (it stamps locked_at/locked_by)
-- left that job claimable by NO ONE — stranded in 'purging' forever, so a GDPR
-- Article 17 erasure could silently never complete.
--
-- The fix is off-chain (blob-purge-repo.ts): the claim now ALSO reclaims jobs
-- whose lease has expired (status='purging' AND locked_at older than a lease
-- timeout), stamping a fresh unique lock token; and every status transition is
-- fenced on locked_by so a stale worker cannot overwrite the new lease owner.
-- This index supports the new stale-lease scan (purging rows are few, but the
-- partial index keeps the reclaim probe from touching live rows).

CREATE INDEX IF NOT EXISTS idx_tenant_blob_purge_stale_lease
  ON tenant_blob_purge_jobs (locked_at)
  WHERE status = 'purging';
