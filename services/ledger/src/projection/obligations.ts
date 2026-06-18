/**
 * Ledger AP/AR projection from the canonical domain (Phase 5 deep refactor,
 * PR-F, RFC 0005).
 *
 * ledger_obligations and ledger_counterparties become a rebuildable projection
 * of canonical_obligation / canonical_counterparty (canonical/0002), the same
 * read-projection move ledger_gl_accounts made for the chart of accounts. The
 * Ledger reads canonical_* read-only (sanctioned cross-layer read; it never
 * writes canonical).
 *
 * Overlay reapplication (RFC 0005 §4.1) is richer here than for GL accounts,
 * because these rows accrue Phase-4 reconciliation state:
 *   - confidence is lifted UPWARD-ONLY: GREATEST(existing, projected) preserves
 *     a corroboration lift (a matched obligation rises toward 0.9) across a
 *     rebuild rather than resetting to the provider-projected 0.85.
 *   - provenance: a human_confirmed row stays human_confirmed; otherwise it
 *     refreshes to the provider value ('extracted'). Corroboration promotes
 *     low-trust provenance TO extracted, which the projection also writes, so
 *     the two never disagree.
 *   - a human_confirmed counterparty NAME survives; provider fields refresh.
 *   - the Ledger row id is STABLE across rebuild (upsert on the canonical key),
 *     so ledger_reconciliation_matches that reference it are never orphaned.
 *
 * Projected confidence/provenance match the live merge_accounting_v1 extractor
 * (counterparty 0.8, obligation 0.85, provenance 'extracted') so the eventual
 * cutover is behaviour-preserving.
 *
 * NOTE: this module is callable + tested but NOT wired to a worker. The live
 * extractor still writes the Ledger directly; running a projection worker in
 * parallel would double-write. The cutover is a separate PR.
 */

import {
  newCounterpartyId,
  newObligationId,
  withTenantScope,
  type AuditEmitter,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";

const PROJECTED_COUNTERPARTY_CONFIDENCE = 0.8;
const PROJECTED_OBLIGATION_CONFIDENCE = 0.85;
const EPOCH_ISO = new Date(0).toISOString();

interface CanonicalCounterpartyRow {
  id: string;
  name: string;
  normalized_name: string | null;
  type: string;
  email: string | null;
  source_ids: string[];
  evidence_ids: string[];
}

interface CanonicalObligationRow {
  id: string;
  direction: string;
  type: string;
  canonical_counterparty_id: string | null;
  amount: string;
  currency: string | null;
  issue_date: string | null;
  due_date: string | null;
  status: string | null;
  source_ids: string[];
  evidence_ids: string[];
  extensions: Record<string, unknown>;
}

/** Map a provider obligation status to the compact Ledger status enum. */
function ledgerStatus(canonicalStatus: string | null, dueDate: string | null): string {
  if (canonicalStatus !== null && canonicalStatus.toUpperCase() === "PAID") return "paid";
  return dueDate !== null ? "due" : "upcoming";
}

async function upsertProjectedCounterparty(
  c: TenantScopedClient,
  tenantId: string,
  row: CanonicalCounterpartyRow,
): Promise<string> {
  const metadata = {
    canonical: { id: row.id, ...(row.email !== null ? { email: row.email } : {}) },
  };
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO ledger_counterparties
       (id, owner_id, name, normalized_name, type, source_ids, evidence_ids,
        provenance, confidence, metadata, canonical_counterparty_id)
     VALUES ($1,$2,$3,$4,$5,$6::text[],$7::text[],'extracted',$8,$9::jsonb,$10)
     ON CONFLICT (owner_id, canonical_counterparty_id) WHERE canonical_counterparty_id IS NOT NULL
     DO UPDATE SET
        normalized_name = EXCLUDED.normalized_name,
        type = EXCLUDED.type,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        metadata = EXCLUDED.metadata,
        -- overlay: human-confirmed name + provenance survive; confidence rises only.
        name = CASE WHEN ledger_counterparties.provenance = 'human_confirmed'
                    THEN ledger_counterparties.name ELSE EXCLUDED.name END,
        provenance = CASE WHEN ledger_counterparties.provenance = 'human_confirmed'
                          THEN 'human_confirmed' ELSE EXCLUDED.provenance END,
        confidence = GREATEST(ledger_counterparties.confidence, EXCLUDED.confidence),
        updated_at = now()
     RETURNING id`,
    [
      newCounterpartyId(),
      tenantId,
      row.name,
      row.normalized_name,
      row.type,
      row.source_ids,
      row.evidence_ids,
      PROJECTED_COUNTERPARTY_CONFIDENCE,
      JSON.stringify(metadata),
      row.id,
    ],
  );
  const out = rows[0];
  if (out === undefined) throw new Error("upsertProjectedCounterparty returned no row");
  return out.id;
}

async function upsertProjectedObligation(
  c: TenantScopedClient,
  tenantId: string,
  row: CanonicalObligationRow,
  counterpartyId: string,
): Promise<string> {
  const dueDate = row.due_date ?? row.issue_date ?? EPOCH_ISO;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO ledger_obligations
       (id, owner_id, type, counterparty_id, amount_due, currency, due_date, status,
        direction, source_ids, evidence_ids, provenance, confidence, metadata, canonical_obligation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11::text[],'extracted',$12,$13::jsonb,$14)
     ON CONFLICT (owner_id, canonical_obligation_id) WHERE canonical_obligation_id IS NOT NULL
     DO UPDATE SET
        type = EXCLUDED.type,
        counterparty_id = EXCLUDED.counterparty_id,
        amount_due = EXCLUDED.amount_due,
        currency = EXCLUDED.currency,
        due_date = EXCLUDED.due_date,
        status = EXCLUDED.status,
        direction = EXCLUDED.direction,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        metadata = EXCLUDED.metadata,
        -- overlay: human_confirmed provenance sticks; confidence rises only
        -- (preserves the Phase-4 corroboration lift across a rebuild).
        provenance = CASE WHEN ledger_obligations.provenance = 'human_confirmed'
                          THEN 'human_confirmed' ELSE EXCLUDED.provenance END,
        confidence = GREATEST(ledger_obligations.confidence, EXCLUDED.confidence),
        updated_at = now()
     RETURNING id`,
    [
      newObligationId(),
      tenantId,
      row.type,
      counterpartyId,
      row.amount,
      row.currency ?? "USD",
      dueDate,
      ledgerStatus(row.status, row.due_date),
      row.direction,
      row.source_ids,
      row.evidence_ids,
      PROJECTED_OBLIGATION_CONFIDENCE,
      JSON.stringify(row.extensions),
      row.id,
    ],
  );
  const out = rows[0];
  if (out === undefined) throw new Error("upsertProjectedObligation returned no row");
  return out.id;
}

export interface AparRebuildResult {
  counterparties: number;
  obligations: number;
}

/**
 * Rebuild the Ledger AP/AR projection for one tenant from canonical alone, no
 * provider contact (the Phase 5 AC). Counterparties first so obligations
 * resolve their counterparty. Idempotent; preserves human/corroboration overlays.
 */
export async function rebuildAparProjectionFromCanonical(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
): Promise<AparRebuildResult> {
  const result = await withTenantScope(pool, ctx.tenantId, async (c) => {
    // Sanctioned cross-layer read of the canonical store this projects from.
    const { rows: cps } = await c.query<CanonicalCounterpartyRow>(
      `SELECT id, name, normalized_name, type, email, source_ids, evidence_ids
         FROM canonical_counterparty WHERE tenant_id = $1`,
      [ctx.tenantId],
    );
    const ledgerIdByCanonical = new Map<string, string>();
    for (const cp of cps) {
      ledgerIdByCanonical.set(cp.id, await upsertProjectedCounterparty(c, ctx.tenantId, cp));
    }

    const { rows: obls } = await c.query<CanonicalObligationRow>(
      `SELECT id, direction, type, canonical_counterparty_id, amount, currency,
              issue_date, due_date, status, source_ids, evidence_ids,
              COALESCE(extensions, '{}'::jsonb) AS extensions
         FROM canonical_obligation WHERE tenant_id = $1`,
      [ctx.tenantId],
    );
    let obligationCount = 0;
    for (const obl of obls) {
      const counterpartyId =
        obl.canonical_counterparty_id === null
          ? undefined
          : ledgerIdByCanonical.get(obl.canonical_counterparty_id);
      // An obligation whose counterparty has not been projected is skipped this
      // pass; a replay (or fixing the canonical link) resolves it. Never write a
      // null counterparty_id (NOT NULL in ledger_obligations).
      if (counterpartyId === undefined) continue;
      await upsertProjectedObligation(c, ctx.tenantId, obl, counterpartyId);
      obligationCount += 1;
    }
    return { counterparties: cps.length, obligations: obligationCount };
  });

  await audit.emit({
    tenantId: ctx.tenantId,
    layer: "ledger",
    actor: ctx.actor,
    action: "ledger.apar_projection.rebuilt",
    inputs: { source: "canonical_obligation,canonical_counterparty" },
    outputs: result,
  });
  return result;
}
