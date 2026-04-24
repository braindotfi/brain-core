-- Brain wiki_relations table.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.

BEGIN;

CREATE TABLE IF NOT EXISTS wiki_relations (
  id                 TEXT        PRIMARY KEY,                -- Brain ULID: rel_...
  tenant_id          TEXT        NOT NULL,
  src                TEXT        NOT NULL REFERENCES wiki_entities(id),
  dst                TEXT        NOT NULL REFERENCES wiki_entities(id),
  kind               TEXT        NOT NULL
                      CHECK (kind IN ('transacted_with','owes','owed_by','governed_by')),
  attributes         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  valid_from         TIMESTAMPTZ NOT NULL,
  valid_to           TIMESTAMPTZ,
  provenance         TEXT        NOT NULL
                      CHECK (provenance IN (
                        'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                      )),
  confidence         REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_evidence    TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wiki_relations_tenant_src
  ON wiki_relations (tenant_id, src);
CREATE INDEX IF NOT EXISTS idx_wiki_relations_tenant_dst
  ON wiki_relations (tenant_id, dst);
CREATE INDEX IF NOT EXISTS idx_wiki_relations_tenant_kind
  ON wiki_relations (tenant_id, kind);

ALTER TABLE wiki_relations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON wiki_relations
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON wiki_relations
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
