/**
 * Canonical accounting repository — idempotent upserts keyed on
 * (tenant_id, source_system, source_natural_key). Replaying the same Merge
 * page upserts in place rather than duplicating, which is what makes the layer
 * a rebuildable projection of raw_parsed (RFC 0005 §4).
 *
 * All functions take a tenant-scoped client (the caller wraps them in
 * withTenantScope, so RLS is enforced and the work is one transaction).
 */

import {
  newCanonicalGlAccountId,
  newCanonicalJournalEntryId,
  newCanonicalJournalLineId,
} from "@brain/shared";
import type { TenantScopedClient } from "@brain/shared";
import type { GlAccountUpsert, JournalEntryUpsert } from "../projectors/merge-accounting.js";

export interface UpsertResult {
  id: string;
  created: boolean;
}

export async function upsertGlAccount(
  c: TenantScopedClient,
  tenantId: string,
  input: GlAccountUpsert,
): Promise<UpsertResult> {
  const { rows } = await c.query<{ id: string; created: boolean }>(
    `INSERT INTO canonical_gl_account
       (id, tenant_id, source_system, source_natural_key, name, classification,
        account_number, currency, status, provenance, confidence,
        source_ids, evidence_ids, extensions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13::text[],$14::jsonb)
     ON CONFLICT (tenant_id, source_system, source_natural_key) DO UPDATE SET
        name = EXCLUDED.name,
        classification = EXCLUDED.classification,
        account_number = EXCLUDED.account_number,
        currency = EXCLUDED.currency,
        status = EXCLUDED.status,
        provenance = EXCLUDED.provenance,
        confidence = EXCLUDED.confidence,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        extensions = EXCLUDED.extensions,
        updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      newCanonicalGlAccountId(),
      tenantId,
      input.sourceSystem,
      input.sourceNaturalKey,
      input.name,
      input.classification,
      input.accountNumber,
      input.currency,
      input.status,
      input.common.provenance,
      input.common.confidence,
      input.common.sourceIds,
      input.common.evidenceIds,
      JSON.stringify(input.extensions),
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("upsertGlAccount returned no row");
  return { id: row.id, created: row.created };
}

export async function upsertJournalEntry(
  c: TenantScopedClient,
  tenantId: string,
  input: JournalEntryUpsert,
): Promise<UpsertResult> {
  const { rows } = await c.query<{ id: string; created: boolean }>(
    `INSERT INTO canonical_journal_entry
       (id, tenant_id, source_system, source_natural_key, posted_at, memo,
        currency, status, provenance, confidence, source_ids, evidence_ids, extensions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],$13::jsonb)
     ON CONFLICT (tenant_id, source_system, source_natural_key) DO UPDATE SET
        posted_at = EXCLUDED.posted_at,
        memo = EXCLUDED.memo,
        currency = EXCLUDED.currency,
        status = EXCLUDED.status,
        provenance = EXCLUDED.provenance,
        confidence = EXCLUDED.confidence,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        extensions = EXCLUDED.extensions,
        updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      newCanonicalJournalEntryId(),
      tenantId,
      input.sourceSystem,
      input.sourceNaturalKey,
      input.postedAt,
      input.memo,
      input.currency,
      input.status,
      input.common.provenance,
      input.common.confidence,
      input.common.sourceIds,
      input.common.evidenceIds,
      JSON.stringify(input.extensions),
    ],
  );
  const header = rows[0];
  if (header === undefined) throw new Error("upsertJournalEntry returned no row");

  // The source page is authoritative for the entry's legs: replace them so a
  // corrected page converges rather than accreting stale lines. Idempotent —
  // identical content re-inserts to the same shape.
  await c.query(`DELETE FROM canonical_journal_line WHERE journal_entry_id = $1`, [header.id]);

  for (const line of input.lines) {
    // Best-effort resolution of the GL account reference to the canonical id.
    // Null until that account page has itself been projected; a replay fills it.
    const glAccountId =
      line.glAccountKey === null
        ? null
        : ((
            await c.query<{ id: string }>(
              `SELECT id FROM canonical_gl_account
                WHERE source_system = $1 AND source_natural_key = $2`,
              [input.sourceSystem, line.glAccountKey],
            )
          ).rows[0]?.id ?? null);

    await c.query(
      `INSERT INTO canonical_journal_line
         (id, tenant_id, journal_entry_id, line_number, gl_account_id, gl_account_key,
          direction, amount, currency, description, extensions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        newCanonicalJournalLineId(),
        tenantId,
        header.id,
        line.lineNumber,
        glAccountId,
        line.glAccountKey,
        line.direction,
        line.amount,
        line.currency,
        line.description,
        JSON.stringify(line.extensions),
      ],
    );
  }

  return { id: header.id, created: header.created };
}
