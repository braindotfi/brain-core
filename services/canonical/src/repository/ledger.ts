import { newCanonicalAccountId, newCanonicalTransactionId } from "@brain/shared";
import type { TenantScopedClient } from "@brain/shared";
import type {
  CanonicalAccountUpsert,
  CanonicalTransactionUpsert,
} from "../projectors/connector-ledger.js";

export interface UpsertResult {
  id: string;
  created: boolean;
}

export async function upsertCanonicalAccount(
  c: TenantScopedClient,
  tenantId: string,
  input: CanonicalAccountUpsert,
): Promise<UpsertResult> {
  const { rows } = await c.query<{ id: string; created: boolean }>(
    `INSERT INTO canonical_account
       (id, tenant_id, source_system, source_natural_key, institution, external_account_id,
        account_type, name, currency, current_balance, available_balance, status,
        provenance, confidence, source_ids, evidence_ids, extensions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16::text[],$17::jsonb)
     ON CONFLICT (tenant_id, source_system, source_natural_key) DO UPDATE SET
        institution = EXCLUDED.institution,
        external_account_id = EXCLUDED.external_account_id,
        account_type = EXCLUDED.account_type,
        name = EXCLUDED.name,
        currency = EXCLUDED.currency,
        current_balance = EXCLUDED.current_balance,
        available_balance = EXCLUDED.available_balance,
        status = EXCLUDED.status,
        provenance = EXCLUDED.provenance,
        confidence = EXCLUDED.confidence,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        extensions = EXCLUDED.extensions,
        updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      newCanonicalAccountId(),
      tenantId,
      input.sourceSystem,
      input.sourceNaturalKey,
      input.institution,
      input.externalAccountId,
      input.accountType,
      input.name,
      input.currency,
      input.currentBalance,
      input.availableBalance,
      input.status,
      input.common.provenance,
      input.common.confidence,
      input.common.sourceIds,
      input.common.evidenceIds,
      JSON.stringify(input.extensions),
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("upsertCanonicalAccount returned no row");
  return { id: row.id, created: row.created };
}

export async function upsertCanonicalTransaction(
  c: TenantScopedClient,
  tenantId: string,
  input: CanonicalTransactionUpsert,
): Promise<UpsertResult> {
  const accountId =
    input.accountSourceKey === null
      ? null
      : ((
          await c.query<{ id: string }>(
            `SELECT id FROM canonical_account
              WHERE tenant_id = $1 AND source_system = $2 AND source_natural_key = $3`,
            [tenantId, input.sourceSystem, input.accountSourceKey],
          )
        ).rows[0]?.id ?? null);
  const counterpartyId =
    input.counterpartySourceKey === null
      ? null
      : ((
          await c.query<{ id: string }>(
            `SELECT id FROM canonical_counterparty
              WHERE tenant_id = $1 AND source_system = $2 AND source_natural_key = $3`,
            [tenantId, input.sourceSystem, input.counterpartySourceKey],
          )
        ).rows[0]?.id ?? null);

  const { rows } = await c.query<{ id: string; created: boolean }>(
    `INSERT INTO canonical_transaction
       (id, tenant_id, source_system, source_natural_key, canonical_account_id,
        account_source_key, canonical_counterparty_id, counterparty_source_key,
        amount, currency, direction, transaction_date, posted_date, status,
        description_raw, description_normalized, reconciliation_status,
        provenance, confidence, source_ids, evidence_ids, extensions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::text[],$21::text[],$22::jsonb)
     ON CONFLICT (tenant_id, source_system, source_natural_key) DO UPDATE SET
        canonical_account_id = EXCLUDED.canonical_account_id,
        account_source_key = EXCLUDED.account_source_key,
        canonical_counterparty_id = EXCLUDED.canonical_counterparty_id,
        counterparty_source_key = EXCLUDED.counterparty_source_key,
        amount = EXCLUDED.amount,
        currency = EXCLUDED.currency,
        direction = EXCLUDED.direction,
        transaction_date = EXCLUDED.transaction_date,
        posted_date = EXCLUDED.posted_date,
        status = EXCLUDED.status,
        description_raw = EXCLUDED.description_raw,
        description_normalized = EXCLUDED.description_normalized,
        reconciliation_status = EXCLUDED.reconciliation_status,
        provenance = EXCLUDED.provenance,
        confidence = EXCLUDED.confidence,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        extensions = EXCLUDED.extensions,
        updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      newCanonicalTransactionId(),
      tenantId,
      input.sourceSystem,
      input.sourceNaturalKey,
      accountId,
      input.accountSourceKey,
      counterpartyId,
      input.counterpartySourceKey,
      input.amount,
      input.currency,
      input.direction,
      input.transactionDate,
      input.postedDate,
      input.status,
      input.descriptionRaw,
      input.descriptionNormalized,
      input.reconciliationStatus,
      input.common.provenance,
      input.common.confidence,
      input.common.sourceIds,
      input.common.evidenceIds,
      JSON.stringify(input.extensions),
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("upsertCanonicalTransaction returned no row");
  return { id: row.id, created: row.created };
}
