/**
 * Ledger projection of the canonical chart of accounts (Phase 5 PR-C, RFC 0005).
 *
 * The Ledger-side read-projection of canonical_gl_account. This is the exact
 * analogue, one layer up, of the sanctioned Wiki-reads-Ledger projection: the
 * Ledger reads canonical_* tables (it never writes them) and materializes a
 * compact projection it owns. The projection is rebuildable from canonical
 * alone, without recontacting providers (the Phase 5 AC).
 *
 * Overlay reapplication (RFC 0005 §4.1): a projected row is provider-derived
 * ('extracted'). A human correction (e.g. a renamed account) sets
 * provenance='human_confirmed'; the overlay-preserving upsert keeps the human
 * name + provenance across a rebuild while still refreshing provider-derived
 * fields (classification, account number, currency, status). So rebuilding from
 * canonical is lossless with respect to human decisions, not just provider data.
 */

import {
  brainError,
  newLedgerGlAccountId,
  withTenantScope,
  type AuditEmitter,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";

/** Provider-projected rows are full-trust structured data, but below human confirmation. */
const PROJECTED_CONFIDENCE = 0.9;
const CONFIRMED_CONFIDENCE = 1.0;

export interface LedgerGlAccountInput {
  sourceSystem: string;
  sourceNaturalKey: string;
  canonicalGlAccountId: string;
  name: string;
  classification: string;
  accountNumber: string | null;
  currency: string | null;
  status: string | null;
  sourceIds: string[];
  evidenceIds: string[];
}

interface CanonicalGlAccountRow {
  id: string;
  source_system: string;
  source_natural_key: string;
  name: string;
  classification: string;
  account_number: string | null;
  currency: string | null;
  status: string | null;
  source_ids: string[];
  evidence_ids: string[];
}

/** Pure map: a canonical GL account row -> the Ledger projection input. */
export function toLedgerGlAccountInput(row: CanonicalGlAccountRow): LedgerGlAccountInput {
  return {
    sourceSystem: row.source_system,
    sourceNaturalKey: row.source_natural_key,
    canonicalGlAccountId: row.id,
    name: row.name,
    classification: row.classification,
    accountNumber: row.account_number,
    currency: row.currency,
    status: row.status,
    sourceIds: row.source_ids,
    evidenceIds: row.evidence_ids,
  };
}

/**
 * Overlay-preserving upsert. Provider-derived fields always refresh from
 * canonical; a human_confirmed name/provenance/confidence is preserved.
 */
export async function upsertLedgerGlAccount(
  c: TenantScopedClient,
  tenantId: string,
  input: LedgerGlAccountInput,
): Promise<{ id: string; created: boolean }> {
  const { rows } = await c.query<{ id: string; created: boolean }>(
    `INSERT INTO ledger_gl_accounts
       (id, tenant_id, source_system, source_natural_key, canonical_gl_account_id,
        name, classification, account_number, currency, status, provenance, confidence,
        source_ids, evidence_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'extracted',$11,$12::text[],$13::text[])
     ON CONFLICT (tenant_id, source_system, source_natural_key) DO UPDATE SET
        canonical_gl_account_id = EXCLUDED.canonical_gl_account_id,
        classification = EXCLUDED.classification,
        account_number = EXCLUDED.account_number,
        currency = EXCLUDED.currency,
        status = EXCLUDED.status,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        -- Overlay: a human-confirmed name and its provenance/confidence survive
        -- a rebuild; otherwise refresh from canonical.
        name = CASE WHEN ledger_gl_accounts.provenance = 'human_confirmed'
                    THEN ledger_gl_accounts.name ELSE EXCLUDED.name END,
        provenance = CASE WHEN ledger_gl_accounts.provenance = 'human_confirmed'
                          THEN 'human_confirmed' ELSE EXCLUDED.provenance END,
        confidence = CASE WHEN ledger_gl_accounts.provenance = 'human_confirmed'
                          THEN ledger_gl_accounts.confidence ELSE EXCLUDED.confidence END,
        updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      newLedgerGlAccountId(),
      tenantId,
      input.sourceSystem,
      input.sourceNaturalKey,
      input.canonicalGlAccountId,
      input.name,
      input.classification,
      input.accountNumber,
      input.currency,
      input.status,
      PROJECTED_CONFIDENCE,
      input.sourceIds,
      input.evidenceIds,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("upsertLedgerGlAccount returned no row");
  return { id: row.id, created: row.created };
}

export interface RebuildResult {
  projected: number;
}

/**
 * Rebuild the Ledger chart-of-accounts projection for one tenant from canonical
 * alone -- no provider contact. Idempotent; preserves human overlays. This is
 * the Phase 5 acceptance criterion in code.
 */
export async function rebuildAccountingProjectionFromCanonical(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
): Promise<RebuildResult> {
  const projected = await withTenantScope(pool, ctx.tenantId, async (c) => {
    // Sanctioned cross-layer read: the Ledger reads the canonical store it
    // projects from (the Wiki-reads-Ledger pattern, one layer up). Read-only.
    const { rows } = await c.query<CanonicalGlAccountRow>(
      `SELECT id, source_system, source_natural_key, name, classification,
              account_number, currency, status, source_ids, evidence_ids
         FROM canonical_gl_account
        WHERE tenant_id = $1`,
      [ctx.tenantId],
    );
    let count = 0;
    for (const row of rows) {
      await upsertLedgerGlAccount(c, ctx.tenantId, toLedgerGlAccountInput(row));
      count += 1;
    }
    return count;
  });

  await audit.emit({
    tenantId: ctx.tenantId,
    layer: "ledger",
    actor: ctx.actor,
    action: "ledger.accounting_projection.rebuilt",
    inputs: { source: "canonical_gl_account" },
    outputs: { projected },
  });
  return { projected };
}

/**
 * Record a human correction to a projected GL account's name (HITL). Sets
 * provenance to human_confirmed so the name survives subsequent rebuilds.
 */
export async function confirmGlAccountName(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  glAccountId: string,
  name: string,
): Promise<void> {
  const updated = await withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `UPDATE ledger_gl_accounts
          SET name = $2, provenance = 'human_confirmed', confidence = $3, updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [glAccountId, name, CONFIRMED_CONFIDENCE],
    );
    return rows[0];
  });
  if (updated === undefined) {
    throw brainError("ledger_row_invalid", `gl account not found: ${glAccountId}`);
  }
  await audit.emit({
    tenantId: ctx.tenantId,
    layer: "ledger",
    actor: ctx.actor,
    action: "ledger.gl_account.name_confirmed",
    inputs: { gl_account_id: glAccountId },
    outputs: { provenance: "human_confirmed" },
  });
}
