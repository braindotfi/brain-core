-- Brain Ledger: keep pgcrypto functions visible to schema-per-test migrations.
--
-- Migration 0031 made pgcrypto self-installing, but when the migrator runs
-- with search_path set to an isolated test schema, PostgreSQL can install the
-- extension objects in that schema. The extension then exists database-wide,
-- so later isolated schemas skip CREATE EXTENSION IF NOT EXISTS and cannot
-- resolve digest(...), which the counterparty payment-instruction trigger uses.
--
-- Pin pgcrypto to public so every tenant-scoped or test schema can resolve it
-- through the standard schema, public search_path.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
ALTER EXTENSION pgcrypto SET SCHEMA public;

COMMIT;
