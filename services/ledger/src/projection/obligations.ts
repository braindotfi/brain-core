/**
 * Ledger AP/AR projection from the canonical domain (Phase 5 deep refactor,
 * RFC 0005). ledger_obligations / ledger_counterparties are a rebuildable
 * projection of canonical_obligation / canonical_counterparty (canonical/0002).
 *
 * As of the cutover (PR-G) this is the PRIMARY path for Merge-sourced
 * obligations/counterparties: the merge_accounting extractor no longer writes
 * them to the Ledger directly; they flow Raw -> canonical projector -> canonical
 * -> this projection. (Stripe / Finch / Plaid / doc_obligation paths are
 * unchanged and still write the Ledger directly.)
 *
 * Identity is canonical-source-keyed, NOT name-deduped: a Merge vendor and a
 * document vendor with the same name are DISTINCT observations here, linked by
 * the Phase-4 counterparty_duplicate resolver (link, don't merge). This is the
 * §13 model; it differs from the old extractor's creation-time name dedup.
 *
 * Overlay reapplication (RFC 0005 §4.1): confidence rises only
 * (GREATEST(existing, projected)) so a Phase-4 corroboration lift survives a
 * rebuild; human_confirmed provenance + a confirmed counterparty name survive;
 * the Ledger row id is stable on the canonical key so reconciliation match rows
 * are never orphaned. Projected confidence/provenance match the old extractor
 * (cp 0.8, obl 0.85, extracted) so the cutover is behaviour-preserving except
 * for the deliberate identity change above.
 */

import {
  newCounterpartyId,
  newObligationId,
  startManagedInterval,
  leasedCycle,
  withTenantScope,
  type AuditEmitter,
  type ManagedWorker,
  type MetricsEmitter,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import { normalizeName } from "../service/writes.js";

const EPOCH_ISO = new Date(0).toISOString();

/** Per-provenance default when a canonical record carries no explicit confidence. */
const DEFAULT_CONFIDENCE: Readonly<Record<string, number>> = {
  extracted: 0.85,
  human_confirmed: 1.0,
  agent_contributed: 0.5,
  customer_asserted: 0.5,
};

/**
 * The confidence to project, carrying canonical's trust through with the §3.2
 * agent ceiling applied (agent_contributed / customer_asserted cap at 0.5), so a
 * document-extracted obligation stays low-trust and the §6 gate still refuses it.
 */
function projectedConfidence(provenance: string, confidence: number | null): number {
  const base = confidence ?? DEFAULT_CONFIDENCE[provenance] ?? 0.5;
  return provenance === "agent_contributed" || provenance === "customer_asserted"
    ? Math.min(base, 0.5)
    : base;
}

interface CanonicalCounterpartyRow {
  id: string;
  tenant_id: string;
  name: string;
  normalized_name: string | null;
  type: string;
  email: string | null;
  provenance: string;
  confidence: number | null;
  source_ids: string[];
  evidence_ids: string[];
}

interface CanonicalObligationRow {
  id: string;
  tenant_id: string;
  direction: string;
  type: string;
  canonical_counterparty_id: string | null;
  amount: string;
  currency: string | null;
  issue_date: string | null;
  due_date: string | null;
  status: string | null;
  provenance: string;
  confidence: number | null;
  source_ids: string[];
  evidence_ids: string[];
  extensions: Record<string, unknown>;
}

function ledgerStatus(canonicalStatus: string | null, dueDate: string | null): string {
  if (canonicalStatus !== null && canonicalStatus.toUpperCase() === "PAID") return "paid";
  return dueDate !== null ? "due" : "upcoming";
}

function ledgerCurrency(canonicalCurrency: string | null): string {
  if (canonicalCurrency === null) return "USD";
  if (!/^[A-Z]{3}$/.test(canonicalCurrency)) {
    throw new Error("currency must be a 3-letter ISO 4217 code");
  }
  return canonicalCurrency;
}

/** Upsert one canonical counterparty into the Ledger projection; returns the Ledger id. */
export async function projectCanonicalCounterparty(
  c: TenantScopedClient,
  tenantId: string,
  row: CanonicalCounterpartyRow,
): Promise<string> {
  const metadata = {
    canonical: { id: row.id, ...(row.email !== null ? { email: row.email } : {}) },
  };
  // Re-normalize with the LEDGER's normalizeName so the projected row's
  // normalized_name is consistent with every other ledger counterparty -- the
  // counterparty_duplicate matcher compares normalized_name equality, so this
  // is what links a projected Merge vendor to a doc/Plaid observation of the
  // same org (canonical's own normalized_name may use a coarser algorithm).
  const normalized = normalizeName(row.name) || null;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO ledger_counterparties
       (id, owner_id, name, normalized_name, type, source_ids, evidence_ids,
        provenance, confidence, metadata, canonical_counterparty_id)
     VALUES ($1,$2,$3,$4,$5,$6::text[],$7::text[],$8,$9,$10::jsonb,$11)
     ON CONFLICT (owner_id, canonical_counterparty_id) WHERE canonical_counterparty_id IS NOT NULL
     DO UPDATE SET
        normalized_name = EXCLUDED.normalized_name,
        type = EXCLUDED.type,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        metadata = EXCLUDED.metadata,
        name = CASE WHEN ledger_counterparties.provenance = 'human_confirmed'
                    THEN ledger_counterparties.name ELSE EXCLUDED.name END,
        -- Monotonic trust: never demote a human_confirmed or corroboration-
        -- promoted (extracted) row back to the provider-projected provenance.
        provenance = CASE WHEN ledger_counterparties.provenance IN ('human_confirmed','extracted')
                          THEN ledger_counterparties.provenance ELSE EXCLUDED.provenance END,
        confidence = GREATEST(ledger_counterparties.confidence, EXCLUDED.confidence),
        updated_at = now()
     RETURNING id`,
    [
      newCounterpartyId(),
      tenantId,
      row.name,
      normalized,
      row.type,
      row.source_ids,
      row.evidence_ids,
      row.provenance,
      projectedConfidence(row.provenance, row.confidence),
      JSON.stringify(metadata),
      row.id,
    ],
  );
  const out = rows[0];
  if (out === undefined) throw new Error("projectCanonicalCounterparty returned no row");
  return out.id;
}

/**
 * Upsert one canonical obligation into the Ledger projection. Resolves its
 * counterparty via the canonical link; returns false (skipped) if that
 * counterparty has not been projected yet (a later pass resolves it).
 */
export async function projectCanonicalObligation(
  c: TenantScopedClient,
  tenantId: string,
  row: CanonicalObligationRow,
): Promise<boolean> {
  if (row.canonical_counterparty_id === null) return false;
  const { rows: cp } = await c.query<{ id: string }>(
    `SELECT id FROM ledger_counterparties
      WHERE owner_id = $1 AND canonical_counterparty_id = $2`,
    [tenantId, row.canonical_counterparty_id],
  );
  const counterpartyId = cp[0]?.id;
  if (counterpartyId === undefined) return false;

  const dueDate = row.due_date ?? row.issue_date ?? EPOCH_ISO;
  await c.query(
    `INSERT INTO ledger_obligations
       (id, owner_id, type, counterparty_id, amount_due, currency, due_date, status,
        direction, source_ids, evidence_ids, provenance, confidence, metadata, canonical_obligation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11::text[],$12,$13,$14::jsonb,$15)
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
        -- Monotonic trust: a corroboration lift (agent_contributed -> extracted)
        -- or human confirmation survives a rebuild; never demote to the
        -- provider-projected provenance. Confidence rises only.
        provenance = CASE WHEN ledger_obligations.provenance IN ('human_confirmed','extracted')
                          THEN ledger_obligations.provenance ELSE EXCLUDED.provenance END,
        confidence = GREATEST(ledger_obligations.confidence, EXCLUDED.confidence),
        updated_at = now()`,
    [
      newObligationId(),
      tenantId,
      row.type,
      counterpartyId,
      row.amount,
      ledgerCurrency(row.currency),
      dueDate,
      ledgerStatus(row.status, row.due_date),
      row.direction,
      row.source_ids,
      row.evidence_ids,
      row.provenance,
      projectedConfidence(row.provenance, row.confidence),
      JSON.stringify(row.extensions),
      row.id,
    ],
  );
  return true;
}

export interface AparRebuildResult {
  counterparties: number;
  obligations: number;
}

const SELECT_CANONICAL_COUNTERPARTY =
  "id, tenant_id, name, normalized_name, type, email, provenance, confidence, source_ids, evidence_ids";
const SELECT_CANONICAL_OBLIGATION =
  "id, tenant_id, direction, type, canonical_counterparty_id, amount, currency, " +
  "issue_date, due_date, status, provenance, confidence, source_ids, evidence_ids, " +
  "COALESCE(extensions, '{}'::jsonb) AS extensions";

/**
 * Rebuild the Ledger AP/AR projection for one tenant from canonical alone, no
 * provider contact (the Phase 5 AC). Counterparties first so obligations resolve
 * their link. Idempotent; preserves human/corroboration overlays.
 */
export async function rebuildAparProjectionFromCanonical(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
): Promise<AparRebuildResult> {
  const result = await withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows: cps } = await c.query<CanonicalCounterpartyRow>(
      `SELECT ${SELECT_CANONICAL_COUNTERPARTY} FROM canonical_counterparty WHERE tenant_id = $1`,
      [ctx.tenantId],
    );
    for (const cp of cps) await projectCanonicalCounterparty(c, ctx.tenantId, cp);

    const { rows: obls } = await c.query<CanonicalObligationRow>(
      `SELECT ${SELECT_CANONICAL_OBLIGATION} FROM canonical_obligation WHERE tenant_id = $1`,
      [ctx.tenantId],
    );
    let obligationCount = 0;
    for (const obl of obls) {
      if (await projectCanonicalObligation(c, ctx.tenantId, obl)) obligationCount += 1;
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

// ---------------------------------------------------------------------------
// Steady-state incremental worker: keeps the Ledger AP/AR projection current as
// canonical grows. Cross-tenant poll (privileged pool); per-row upserts
// tenant-scoped. Counterparties project ahead of obligations each cycle; an
// obligation whose counterparty is not yet projected is retried next cycle.
// ---------------------------------------------------------------------------

export interface LedgerAparProjectionWorkerDeps {
  pool: Pool;
  /** Optional: emits brain.ledger.apar_projection.records.count so a stalled
   *  canonical->Ledger obligation projection is observable. No-op when absent. */
  metrics?: MetricsEmitter;
}

export interface LedgerAparProjectionWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
}

export type LedgerAparProjectionWorker = ManagedWorker;

export async function runLedgerAparProjectionCycle(
  deps: LedgerAparProjectionWorkerDeps,
  opts?: LedgerAparProjectionWorkerOptions,
): Promise<void> {
  const batchSize = opts?.batchSize ?? 50;

  try {
    const { rows: cps } = await deps.pool.query<CanonicalCounterpartyRow>(
      `SELECT cc.id, cc.tenant_id, cc.name, cc.normalized_name, cc.type, cc.email,
              cc.provenance, cc.confidence, cc.source_ids, cc.evidence_ids
         FROM canonical_counterparty cc
         LEFT JOIN ledger_counterparties lc
           ON lc.owner_id = cc.tenant_id AND lc.canonical_counterparty_id = cc.id
        WHERE lc.id IS NULL OR lc.updated_at < cc.updated_at
        ORDER BY cc.updated_at ASC
        LIMIT $1`,
      [batchSize],
    );
    for (const cp of cps) {
      await withTenantScope(deps.pool, cp.tenant_id, (c) =>
        projectCanonicalCounterparty(c, cp.tenant_id, cp),
      );
    }
  } catch (err) {
    console.error("[ledgerAparProjector] counterparty cycle failed:", err);
  }

  try {
    const { rows: obls } = await deps.pool.query<CanonicalObligationRow>(
      `SELECT co.id, co.tenant_id, co.direction, co.type, co.canonical_counterparty_id,
              co.amount, co.currency, co.issue_date, co.due_date, co.status,
              co.provenance, co.confidence, co.source_ids, co.evidence_ids,
              COALESCE(co.extensions, '{}'::jsonb) AS extensions
         FROM canonical_obligation co
         LEFT JOIN ledger_obligations lo
           ON lo.owner_id = co.tenant_id AND lo.canonical_obligation_id = co.id
        WHERE lo.id IS NULL OR lo.updated_at < co.updated_at
        ORDER BY co.updated_at ASC
        LIMIT $1`,
      [batchSize],
    );
    let projected = 0;
    for (const obl of obls) {
      const ok = await withTenantScope(deps.pool, obl.tenant_id, (c) =>
        projectCanonicalObligation(c, obl.tenant_id, obl),
      );
      if (ok) projected += 1;
    }
    if (projected > 0) {
      deps.metrics?.increment("brain.ledger.apar_projection.records.count", undefined, projected);
    }
  } catch (err) {
    console.error("[ledgerAparProjector] obligation cycle failed:", err);
  }

  // Gauge the age of the oldest canonical AP/AR record not yet projected to the
  // Ledger, so a stalled canonical->Ledger projection surfaces as rising lag.
  if (deps.metrics !== undefined) {
    try {
      const { rows } = await deps.pool.query<{ lag: number }>(
        `SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(t.updated_at)), 0)::float8 AS lag
           FROM (
             SELECT cc.updated_at
               FROM canonical_counterparty cc
               LEFT JOIN ledger_counterparties lc
                 ON lc.owner_id = cc.tenant_id AND lc.canonical_counterparty_id = cc.id
              WHERE lc.id IS NULL OR lc.updated_at < cc.updated_at
             UNION ALL
             SELECT co.updated_at
               FROM canonical_obligation co
               LEFT JOIN ledger_obligations lo
                 ON lo.owner_id = co.tenant_id AND lo.canonical_obligation_id = co.id
              WHERE lo.id IS NULL OR lo.updated_at < co.updated_at
           ) t`,
      );
      deps.metrics.gauge("brain.ledger.apar_projection.lag_seconds", rows[0]?.lag ?? 0);
    } catch (err) {
      console.error("[ledgerAparProjector] lag gauge query failed:", err);
    }
  }
}

export function startLedgerAparProjectionWorker(
  deps: LedgerAparProjectionWorkerDeps,
  opts?: LedgerAparProjectionWorkerOptions,
): LedgerAparProjectionWorker {
  const intervalMs = opts?.intervalMs ?? 15_000;
  // Advisory lease: only one replica projects at a time (multi-replica safe).
  return startManagedInterval(
    leasedCycle({
      pool: deps.pool,
      lockKey: "brain_worker_ledger_apar_projection",
      cycle: () => runLedgerAparProjectionCycle(deps, opts),
      name: "ledger-apar-projection",
      metrics: deps.metrics,
    }),
    intervalMs,
    {
      name: "ledger-apar-projection",
      runImmediately: true,
      onError: (err) => console.error("[ledgerAparProjector] cycle failed:", err),
    },
  );
}
