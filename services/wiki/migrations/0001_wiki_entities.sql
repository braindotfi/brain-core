-- Brain wiki_entities table.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
-- Owner: services/wiki.
--
-- Bitemporal: (valid_from, valid_to) captures when the fact was true in
-- the real world. Superseded versions retain their row — we never mutate.
-- pgvector column enables the /wiki/search semantic path with an ivfflat
-- index; dim=1536 matches OpenAI text-embedding-3-small.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS wiki_entities (
  id                 TEXT        PRIMARY KEY,                -- Brain ULID: ent_...
  tenant_id          TEXT        NOT NULL,
  kind               TEXT        NOT NULL
                      CHECK (kind IN (
                        'account','counterparty','transaction','obligation','policy','agent'
                      )),
  attributes         JSONB       NOT NULL,
  embedding          vector(1536),                            -- nullable when not embedded
  valid_from         TIMESTAMPTZ NOT NULL,
  valid_to           TIMESTAMPTZ,                             -- NULL = currently valid
  provenance         TEXT        NOT NULL
                      CHECK (provenance IN (
                        'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                      )),
  confidence         REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_evidence    TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[], -- raw_parsed ids
  superseded_by      TEXT        REFERENCES wiki_entities(id),    -- new version pointer
  supersedes         TEXT,                                         -- previous version pointer
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wiki_entities_tenant_kind
  ON wiki_entities (tenant_id, kind);

CREATE INDEX IF NOT EXISTS idx_wiki_entities_tenant_valid
  ON wiki_entities (tenant_id, valid_from DESC, valid_to DESC);

-- ivfflat index for semantic search. Tuning target: 100 lists per 1M rows;
-- §3 Layer 2 sets the minimum viable index. Re-indexed periodically
-- outside the request path.
CREATE INDEX IF NOT EXISTS idx_wiki_entities_embedding
  ON wiki_entities USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Partial index for the hot "currently valid" lookup path.
CREATE INDEX IF NOT EXISTS idx_wiki_entities_currently_valid
  ON wiki_entities (tenant_id, kind, id)
  WHERE valid_to IS NULL;

ALTER TABLE wiki_entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON wiki_entities
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON wiki_entities
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON wiki_entities
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
