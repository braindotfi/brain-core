-- H-09 agent contribution quarantine.
--
-- The architecture promises that an agent's first N contributions are quarantined
-- (held out of the extraction pipeline) until a tenant operator releases the
-- agent, after which contributions extract normally. Until now only the 0.5
-- agent-contributed confidence ceiling existed. These columns make the
-- first-N-quarantine real; the 0.5 ceiling stays in place regardless.

BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS contribution_count INT NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS quarantine_threshold INT NOT NULL DEFAULT 5;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS quarantine_cleared_at TIMESTAMPTZ;

COMMIT;
