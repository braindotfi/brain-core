\pset pager off
\pset null '(null)'
BEGIN TRANSACTION READ ONLY;

\echo 'raw_artifacts'
SELECT ra.id AS raw_artifact_id,
       ra.source_ref->>'filename' AS filename,
       ra.source_type,
       ra.mime_type,
       ra.projection_status,
       ej.status AS extraction_status,
       ej.attempt_count,
       ej.parsed_id,
       ej.error->>'code' AS extraction_error_code,
       ej.error->>'message' AS extraction_error_message,
       rp.parser,
       rp.parser_version,
       rp.extracted->>'object_type' AS object_type,
       cpl.projector,
       cpl.records_written,
       cpl.error AS canonical_error,
       cpl.quarantined
  FROM raw_artifacts ra
  LEFT JOIN LATERAL (
    SELECT status, attempt_count, parsed_id, error
      FROM extraction_jobs
     WHERE tenant_id = ra.tenant_id AND raw_id = ra.id
     ORDER BY updated_at DESC
     LIMIT 1
  ) ej ON true
  LEFT JOIN raw_parsed rp ON rp.id = ej.parsed_id AND rp.tenant_id = ra.tenant_id
  LEFT JOIN canonical_projection_log cpl ON cpl.raw_parsed_id = rp.id
 WHERE ra.tenant_id = :'tenant_id'
 ORDER BY ra.ingested_at ASC, ra.id ASC;

\echo 'canonical_obligations'
SELECT source_system, source_natural_key, direction, type, amount, currency, due_date, status,
       source_ids, evidence_ids
  FROM canonical_obligation
 WHERE tenant_id = :'tenant_id'
 ORDER BY updated_at ASC, id ASC;

\echo 'ledger_obligations'
SELECT lo.id, lo.type, lo.direction, lo.amount_due, lo.currency, lo.due_date, lo.status,
       cp.name AS counterparty_name, lo.source_ids, lo.evidence_ids
  FROM ledger_obligations lo
  LEFT JOIN ledger_counterparties cp ON cp.owner_id = lo.owner_id AND cp.id = lo.counterparty_id
 WHERE lo.owner_id = :'tenant_id'
 ORDER BY lo.due_date ASC, lo.id ASC;

\echo 'ledger_invoices'
SELECT li.id, li.invoice_number, li.amount_due, li.currency, li.due_date, li.status,
       cp.name AS counterparty_name, li.source_ids, li.evidence_ids
  FROM ledger_invoices li
  LEFT JOIN ledger_counterparties cp ON cp.owner_id = li.owner_id AND cp.id = li.counterparty_id
 WHERE li.owner_id = :'tenant_id'
 ORDER BY li.due_date ASC, li.id ASC;

\echo 'ledger_transaction_count'
SELECT count(*)::int AS count FROM ledger_transactions WHERE owner_id = :'tenant_id';
COMMIT;
