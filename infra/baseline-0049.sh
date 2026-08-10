#!/bin/sh
# Baseline ledger/0049_pgcrypto_public_schema.sql on Azure Postgres.
#
# WHY: that migration runs
#     CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
#     ALTER EXTENSION pgcrypto SET SCHEMA public;
# Azure Database for PostgreSQL Flexible Server rejects the second statement
# outright -- "SET SCHEMA clause for ALTER EXTENSION is not supported" -- so the
# migration can never apply there, and it blocks every later migration.
#
# The migration exists to rescue databases where pgcrypto was installed into an
# isolated test schema. On a fresh database migration 0031 already creates it
# via search_path (public), so the end state the migration wants is ALREADY
# TRUE and only the unsupported statement is in the way.
#
# This asserts that end state and records the migration as applied with its
# REAL content hash, so the runner skips it and no hash-drift is introduced.
# The migration file itself is untouched -- editing it would break the hash
# check on the VM and staging, which have already applied it.
set -eu

echo "baseline: pgcrypto schema before ->"
psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT COALESCE((SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname='pgcrypto'),'<absent>');"

psql -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;"

# Fail loudly rather than silently baselining a database where pgcrypto really
# is in the wrong schema -- there we would genuinely need the unsupported ALTER
# and a human has to decide.
psql -v ON_ERROR_STOP=1 -c "DO \$\$
BEGIN
  IF (SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname='pgcrypto') <> 'public' THEN
    RAISE EXCEPTION 'pgcrypto is not in public; cannot baseline 0049 (ALTER EXTENSION SET SCHEMA is unsupported on Azure)';
  END IF;
END \$\$;"

psql -v ON_ERROR_STOP=1 -c "
INSERT INTO brain_migrations (key, service, name, sequence, content_sha, applied_by)
VALUES (
  'ledger/0049_pgcrypto_public_schema.sql',
  'ledger',
  '0049_pgcrypto_public_schema.sql',
  '0049',
  decode('11ba27dee7f40ef3115db2703f1faa8aac000ce0a9dc82afb16dbdaf1cc8e421','hex'),
  'azure-baseline'
)
ON CONFLICT (key) DO NOTHING;"

echo "baseline: pgcrypto schema after ->"
psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname='pgcrypto';"
echo "baseline: 0049 row ->"
psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT key || ' applied_by=' || applied_by FROM brain_migrations WHERE key='ledger/0049_pgcrypto_public_schema.sql';"
echo "baseline: done"
