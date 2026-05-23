-- Kill-switch (Agent Autonomy v3, 1b.3): add the `quarantined` agent state.
-- POST /v1/agents/{id}/halt flips an active agent to quarantined and pauses all
-- its in-flight payment intents. Forward-compatible: widens the CHECK only.

BEGIN;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_state_check;

ALTER TABLE agents
  ADD CONSTRAINT agents_state_check
  CHECK (state IN ('pending_onchain', 'active', 'revoked', 'failed', 'quarantined'));

COMMIT;
