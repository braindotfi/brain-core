/**
 * Canonical AP/AR repository (Phase 5 deep refactor, PR-E). Idempotent upserts
 * keyed on (tenant, source_system, source_natural_key), mirroring the accounting
 * repository. Canonical holds provider truth; human/agent overlays live on the
 * Ledger projection (PR-F), not here, so these upserts simply refresh from the
 * source page on replay.
 */

import { newCanonicalCounterpartyId, newCanonicalObligationId } from "@brain/shared";
import type { TenantScopedClient } from "@brain/shared";
import type { CounterpartyUpsert, ObligationUpsert } from "../projectors/merge-apar.js";

export interface UpsertResult {
  id: string;
  created: boolean;
}

export async function upsertCanonicalCounterparty(
  c: TenantScopedClient,
  tenantId: string,
  input: CounterpartyUpsert,
): Promise<UpsertResult> {
  const { rows } = await c.query<{ id: string; created: boolean }>(
    `INSERT INTO canonical_counterparty
       (id, tenant_id, source_system, source_natural_key, name, normalized_name, type, email,
        provenance, confidence, source_ids, evidence_ids, extensions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],$13::jsonb)
     ON CONFLICT (tenant_id, source_system, source_natural_key) DO UPDATE SET
        name = EXCLUDED.name,
        normalized_name = EXCLUDED.normalized_name,
        type = EXCLUDED.type,
        email = EXCLUDED.email,
        provenance = EXCLUDED.provenance,
        confidence = EXCLUDED.confidence,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        extensions = EXCLUDED.extensions,
        updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      newCanonicalCounterpartyId(),
      tenantId,
      input.sourceSystem,
      input.sourceNaturalKey,
      input.name,
      input.normalizedName,
      input.type,
      input.email,
      input.common.provenance,
      input.common.confidence,
      input.common.sourceIds,
      input.common.evidenceIds,
      JSON.stringify(input.extensions),
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("upsertCanonicalCounterparty returned no row");
  return { id: row.id, created: row.created };
}

export async function upsertCanonicalObligation(
  c: TenantScopedClient,
  tenantId: string,
  input: ObligationUpsert,
): Promise<UpsertResult> {
  // Best-effort resolution of the counterparty reference to the canonical id.
  // Null until that contact page has been projected; a replay fills it (contact
  // pages sort ahead of invoice pages in the worker poll).
  const counterpartyId =
    input.counterpartySourceKey === null
      ? null
      : ((
          await c.query<{ id: string }>(
            `SELECT id FROM canonical_counterparty
              WHERE source_system = $1 AND source_natural_key = $2`,
            [input.sourceSystem, input.counterpartySourceKey],
          )
        ).rows[0]?.id ?? null);

  const { rows } = await c.query<{ id: string; created: boolean }>(
    `INSERT INTO canonical_obligation
       (id, tenant_id, source_system, source_natural_key, direction, type,
        canonical_counterparty_id, counterparty_source_key, amount, currency,
        issue_date, due_date, status, provenance, confidence, source_ids, evidence_ids, extensions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::text[],$17::text[],$18::jsonb)
     ON CONFLICT (tenant_id, source_system, source_natural_key) DO UPDATE SET
        direction = EXCLUDED.direction,
        type = EXCLUDED.type,
        canonical_counterparty_id = EXCLUDED.canonical_counterparty_id,
        counterparty_source_key = EXCLUDED.counterparty_source_key,
        amount = EXCLUDED.amount,
        currency = EXCLUDED.currency,
        issue_date = EXCLUDED.issue_date,
        due_date = EXCLUDED.due_date,
        status = EXCLUDED.status,
        provenance = EXCLUDED.provenance,
        confidence = EXCLUDED.confidence,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        extensions = EXCLUDED.extensions,
        updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      newCanonicalObligationId(),
      tenantId,
      input.sourceSystem,
      input.sourceNaturalKey,
      input.direction,
      input.type,
      counterpartyId,
      input.counterpartySourceKey,
      input.amount,
      input.currency,
      input.issueDate,
      input.dueDate,
      input.status,
      input.common.provenance,
      input.common.confidence,
      input.common.sourceIds,
      input.common.evidenceIds,
      JSON.stringify(input.extensions),
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("upsertCanonicalObligation returned no row");
  return { id: row.id, created: row.created };
}
