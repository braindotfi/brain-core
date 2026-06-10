-- Brain Raw -- reconcile the artifact source_type vocabulary.
--
-- Ingestion architecture, Phase 1: the repo carried two disagreeing source
-- vocabularies. The connect-time set in services/raw/src/sources/types.ts
-- (provider-named: netsuite, email_inbound, csv_upload, pdf_upload,
-- alchemy_wallet, eth_address) and the artifact-side set armed by raw/0001
-- (erp_netsuite, email, upload, chain_evm). This migration renames the
-- artifact values in place so one provider-named vocabulary covers both, and
-- widens the CHECK to admit the non-connector origins that live TS code
-- already writes:
--   - wiki_annotation: the Wiki annotate path (wiki-memory-adapter) has been
--     writing this value since v0.4; it violated the old CHECK.
--   - eth_address: connectable per sources/types.ts but absent from the old
--     artifact CHECK.
--
-- `upload` rows split by MIME type into the named document-tier connector
-- types (csv_upload / pdf_upload); anything else becomes the universal
-- fallback `other`, which is also where schema-less generic pushes land going
-- forward.
--
-- Runs cross-tenant by design (migration role is BYPASSRLS/superuser, same as
-- ledger/0029-0030). Idempotent: re-running each UPDATE matches zero rows.

BEGIN;

ALTER TABLE raw_artifacts DROP CONSTRAINT IF EXISTS raw_artifacts_source_type_check;

UPDATE raw_artifacts SET source_type = 'netsuite'       WHERE source_type = 'erp_netsuite';
UPDATE raw_artifacts SET source_type = 'email_inbound'  WHERE source_type = 'email';
UPDATE raw_artifacts SET source_type = 'alchemy_wallet' WHERE source_type = 'chain_evm';

UPDATE raw_artifacts
   SET source_type = CASE
                       WHEN mime_type ILIKE '%csv%'                 THEN 'csv_upload'
                       WHEN mime_type ILIKE '%pdf%'                 THEN 'pdf_upload'
                       ELSE 'other'
                     END
 WHERE source_type = 'upload';

ALTER TABLE raw_artifacts
  ADD CONSTRAINT raw_artifacts_source_type_check
  CHECK (source_type IN (
    'plaid','stripe','netsuite','email_inbound','csv_upload','pdf_upload',
    'alchemy_wallet','eth_address','agent_contributed','wiki_annotation','other'
  ));

COMMIT;
