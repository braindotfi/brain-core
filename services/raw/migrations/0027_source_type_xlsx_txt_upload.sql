-- Brain Raw -- admit first-class XLSX and text upload source types.
-- The upload adapter registry, persisted vocabulary, and API contract must
-- remain aligned so known uploads never fall through to `other`.

BEGIN;

ALTER TABLE raw_artifacts DROP CONSTRAINT IF EXISTS raw_artifacts_source_type_check;
ALTER TABLE raw_artifacts
  ADD CONSTRAINT raw_artifacts_source_type_check
  CHECK (source_type IN ('plaid','stripe','netsuite','email_inbound','csv_upload','xlsx_upload','txt_upload','pdf_upload','alchemy_wallet','eth_address','merge_accounting','finch','agent_contributed','wiki_annotation','other'));

ALTER TABLE raw_sources DROP CONSTRAINT IF EXISTS raw_sources_type_check;
ALTER TABLE raw_sources
  ADD CONSTRAINT raw_sources_type_check
  CHECK (type IN ('plaid','stripe','netsuite','email_inbound','csv_upload','xlsx_upload','txt_upload','pdf_upload','alchemy_wallet','eth_address','merge_accounting','finch'));

COMMIT;
