-- Enable pgvector for the Wiki layer's semantic search index (§3 Layer 2).
CREATE EXTENSION IF NOT EXISTS vector;

-- pgcrypto for UUID / digest helpers used by audit + raw content addressing.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
