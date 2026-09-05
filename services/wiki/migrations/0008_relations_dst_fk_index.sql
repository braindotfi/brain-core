-- brain-migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wiki_relations_dst_fk ON wiki_relations (dst);
