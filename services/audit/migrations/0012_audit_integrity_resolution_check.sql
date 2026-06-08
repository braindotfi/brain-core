-- Codex 9389568 P2: enforce the integrity-finding resolution lifecycle.
--
-- 0011 added the resolution columns (resolved_at, resolution_actor,
-- resolution_reference) and a status CHECK of ('open', 'resolved'), but nothing
-- tied the two together. A row could be status='resolved' with a NULL actor, or
-- status='open' yet carry a resolution reference, so "resolved" carried no
-- guarantee that WHO/WHY were actually recorded. This constraint makes the two
-- valid shapes the only representable ones:
--
--   open     => resolution fields all NULL (nothing resolved it yet)
--   resolved => resolved_at + a non-empty actor + a non-empty reference
--
-- Existing rows are all open with NULL resolution fields (the verifier only
-- inserts open findings), so adding the constraint validates cleanly.

ALTER TABLE audit_integrity_findings
  ADD CONSTRAINT audit_integrity_resolution_complete
  CHECK (
    (
      status = 'open'
      AND resolved_at IS NULL
      AND resolution_actor IS NULL
      AND resolution_reference IS NULL
    )
    OR
    (
      status = 'resolved'
      AND resolved_at IS NOT NULL
      AND resolution_actor IS NOT NULL
      AND length(trim(resolution_actor)) > 0
      AND resolution_reference IS NOT NULL
      AND length(trim(resolution_reference)) > 0
    )
  );
