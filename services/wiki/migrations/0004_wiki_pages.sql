-- Brain wiki_pages table — v0.3 Layer 3 narrative memory.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 3.
--
-- Pages are derived from Ledger + Raw on demand. The body_md column holds
-- the rendered markdown; source_revision is a checksum captured at render
-- time so a stale page can be detected. body_embedding is for Phase-5
-- semantic search across pages (kept nullable so generators that don't
-- need embeddings can skip them).

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS wiki_pages (
  id              TEXT        PRIMARY KEY,                  -- wpg_<ulid>
  tenant_id       TEXT        NOT NULL,
  page_type       TEXT        NOT NULL
                    CHECK (page_type IN (
                      'account','counterparty','obligation','invoice',
                      'agent','policy','monthly_summary','cash_flow'
                    )),
  subject_id      TEXT,                                     -- Ledger row id (NULL for cross-cutting summaries)
  slug            TEXT        NOT NULL,                     -- /accounts/{id}, /monthly-summaries/{YYYY-MM}, ...
  body_md         TEXT        NOT NULL,
  body_embedding  vector(1536),
  rendered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_revision TEXT        NOT NULL,                     -- ledger checksum at render time
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_tenant_type
  ON wiki_pages (tenant_id, page_type);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_tenant_subject
  ON wiki_pages (tenant_id, page_type, subject_id)
  WHERE subject_id IS NOT NULL;

-- Phase 5 ships pgvector index over body_embedding for /memory/search.
-- ivfflat with conservative lists count; re-tuned in Stage 8 / production.
CREATE INDEX IF NOT EXISTS idx_wiki_pages_embedding
  ON wiki_pages USING ivfflat (body_embedding vector_cosine_ops) WITH (lists = 50);

ALTER TABLE wiki_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON wiki_pages
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON wiki_pages
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON wiki_pages
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
