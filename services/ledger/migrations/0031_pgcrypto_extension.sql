-- Brain Ledger -- ensure the pgcrypto extension is present.
--
-- Migration 0027 added the ledger_counterparty_payment_instructions_writer()
-- trigger, whose body calls digest(..., 'sha256') from the pgcrypto extension.
-- In production pgcrypto is installed by tools/postgres-init/01-extensions.sql,
-- but that init script does NOT run for a freshly-bootstrapped schema that only
-- applies migrations (e.g. the tests/invariants DB-integration harness). The
-- trigger then fails at INSERT time with "function digest(text, unknown) does
-- not exist", which surfaced once the lint gate stopped masking the invariants
-- step in CI.
--
-- Make the schema self-contained: create the extension from a migration, the
-- same way the wiki migrations self-create the `vector` extension. PL/pgSQL
-- parses the trigger body lazily (at first call, not at CREATE FUNCTION time),
-- so creating the extension in this later migration is sufficient -- digest()
-- resolves by the time any INSERT fires the 0027 trigger. Idempotent
-- (IF NOT EXISTS), so it is a no-op where pgcrypto is already installed.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
