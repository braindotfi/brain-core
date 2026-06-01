-- Agent Autonomy v3: per-tenant routing category for the agent-router.
--
-- The agent-router scores candidate agents partly by category match: a
-- "business" tenant routes to business agents, a "consumer" tenant to consumer
-- agents (services/agent-router/src/router.ts categoryMismatch penalty). Before
-- this column the category was hardcoded to "business" in the composition root
-- (services/api/src/main.ts), so consumer routing was structurally impossible.
-- This column makes it a real per-tenant value; the resolver in main.ts reads
-- it (caching per tenant, defaulting to "business" on a missing/unreadable row).
--
-- Forward-compatible: ADD COLUMN IF NOT EXISTS with a NOT NULL DEFAULT so
-- existing tenant rows backfill to "business" without a separate data step.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'business'
    CHECK (category IN ('business', 'consumer'));

COMMENT ON COLUMN tenants.category IS
  'Agent-router routing category: business | consumer. Default business. Read by the per-tenant category resolver in services/api/src/main.ts.';

COMMIT;
