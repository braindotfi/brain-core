/**
 * Canonical AP/AR repository (Phase 5 deep refactor, PR-E). Idempotent upserts
 * keyed on (tenant, source_system, source_natural_key), mirroring the accounting
 * repository. Canonical holds provider truth; human/agent overlays live on the
 * Ledger projection (PR-F), not here, so these upserts simply refresh from the
 * source page on replay.
 */

import { newCanonicalCounterpartyId, newCanonicalObligationId } from "@brain/shared";
import type { TenantScopedClient } from "@brain/shared";
import { normalizeName } from "../projectors/merge-apar.js";
import type { CounterpartyUpsert, ObligationUpsert } from "../projectors/merge-apar.js";

const CUSTOMER_ASSERTED_CSV_SOURCE = "customer_asserted_csv";

/**
 * The bare counterparty_id a customer-asserted CSV row references has no
 * guaranteed "contact page" coming the way Merge/document-extraction sources
 * do (see the comment on upsertCanonicalObligation below) - the user may
 * never separately upload a counterparties-type CSV declaring it. Returns a
 * placeholder name derived from any vendor_name/customer_name/counterparty_name
 * extra column the row carried (see connector-ledger.ts's counterpartyNameHint),
 * falling back to the bare source key itself.
 */
function placeholderCounterpartyName(
  extensions: Record<string, unknown>,
  fallback: string,
): string {
  const csv = extensions["customer_asserted_csv"];
  const hint =
    typeof csv === "object" && csv !== null && !Array.isArray(csv)
      ? (csv as Record<string, unknown>)["counterparty_name_hint"]
      : undefined;
  return typeof hint === "string" && hint.length > 0 ? hint : fallback;
}

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
  let counterpartyId =
    input.counterpartySourceKey === null
      ? null
      : ((
          await c.query<{ id: string }>(
            `SELECT id FROM canonical_counterparty
              WHERE tenant_id = $1 AND source_system = $2 AND source_natural_key = $3`,
            [tenantId, input.sourceSystem, input.counterpartySourceKey],
          )
        ).rows[0]?.id ?? null);

  // A customer-asserted CSV row only ever carries a bare counterparty_id
  // string reference - unlike Merge/document-extraction sources, there is no
  // separate "contact page" guaranteed to arrive on a later replay, since the
  // user may never upload a counterparties-type CSV declaring it. Auto-create
  // a placeholder here instead of leaving the obligation stuck unresolved
  // forever with no visible error. upsertCanonicalCounterparty's ON CONFLICT
  // on the same (tenant, source_system, source_natural_key) key means a real
  // declaration later upgrades this placeholder in place, never duplicates it.
  if (
    counterpartyId === null &&
    input.counterpartySourceKey !== null &&
    input.sourceSystem === CUSTOMER_ASSERTED_CSV_SOURCE
  ) {
    const name = placeholderCounterpartyName(input.extensions, input.counterpartySourceKey);
    const placeholder = await upsertCanonicalCounterparty(c, tenantId, {
      sourceSystem: input.sourceSystem,
      sourceNaturalKey: input.counterpartySourceKey,
      name,
      normalizedName: normalizeName(name) || null,
      type: input.direction === "receivable" ? "customer" : "vendor",
      email: null,
      extensions: {
        customer_asserted_csv: {
          auto_created: true,
          reason: "unresolved_counterparty_reference",
        },
      },
      common: { provenance: "customer_asserted", confidence: 0.3, sourceIds: [], evidenceIds: [] },
    });
    counterpartyId = placeholder.id;
  }

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
