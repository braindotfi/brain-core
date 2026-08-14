-- Stable, allowlisted links from a policy decision back to the evaluated action.
-- Never store an unbounded raw action payload in this proof table.

BEGIN;

ALTER TABLE policy_decisions
  ADD COLUMN IF NOT EXISTS source_refs JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
