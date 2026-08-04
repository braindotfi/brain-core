-- Per-tenant usage counts for deterministic /wiki/question intents.
--
-- The suggestion endpoint reads this table only through a tenant-scoped
-- connection. RLS therefore makes ranking data tenant-local even if a route
-- accidentally omits a tenant predicate.

BEGIN;

CREATE TABLE wiki_question_intent_usage (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  intent_id TEXT NOT NULL,
  invocation_count BIGINT NOT NULL DEFAULT 0 CHECK (invocation_count >= 0),
  first_invoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_invoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, intent_id)
);

CREATE INDEX wiki_question_intent_usage_tenant_rank_idx
  ON wiki_question_intent_usage (tenant_id, invocation_count DESC, last_invoked_at DESC);

ALTER TABLE wiki_question_intent_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_question_intent_usage FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON wiki_question_intent_usage
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON wiki_question_intent_usage
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON wiki_question_intent_usage
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT INSERT, UPDATE, DELETE ON wiki_question_intent_usage TO brain_wiki_reader;

COMMIT;
