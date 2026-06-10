/**
 * Ledger write paths.
 *
 * Each writer is the only path that mutates its table. They:
 *   1. Validate input.
 *   2. Apply the §3.2 agent-contributed confidence ceiling (0.5).
 *   3. INSERT ... ON CONFLICT to be naturally idempotent on the dedup key.
 *   4. Emit an audit event of the form `ledger.<entity>.<verb>` carrying
 *      hashes/ids only (§6.1 — no PII in audit inputs).
 *
 * Atomicity caveat. Audit emission happens after the Ledger TX commits;
 * the audit emitter manages its own connection. Same pattern as the Raw
 * ingest path. A shared TX abstraction is post-MVP. Operationally, the
 * §6 pre-execution gate's audit-before/audit-after pair (Phase 4) is
 * the only place this matters for correctness because money never moves
 * without both events landing — Ledger writes are auditable replays
 * even if the audit row lags by a few ms.
 */

import {
  brainError,
  newAccountId,
  newCounterpartyId,
  newObligationId,
  newTransactionId,
  withTenantScope,
  type AuditEmitter,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";

/** §3.2 of Brain_MVP_Architecture.md — agent-contributed rows are capped. */
const AGENT_CONTRIBUTED_CONFIDENCE_CEILING = 0.5;
import type { Pool } from "pg";
import type { AccountRow, CounterpartyRow, TransactionRow } from "../repository/index.js";
import type { ObligationRow } from "../repository/obligations.js";

const PROVENANCE_VALUES = new Set([
  "extracted",
  "inferred",
  "ambiguous",
  "human_confirmed",
  "agent_contributed",
  "customer_asserted",
]);

/**
 * Low-trust provenances share the 0.5 confidence ceiling (Phase 2 trust
 * contract): agent contributions and generic-push / unknown-source data
 * cannot mint high confidence; only corroboration lifts them (persistMatch).
 */
const CAPPED_PROVENANCES = new Set(["agent_contributed", "customer_asserted"]);

function cappedConfidence(provenance: string, raw: number): number {
  if (raw < 0 || raw > 1) {
    throw brainError("ledger_row_invalid", "confidence must be in [0, 1]", {
      details: { confidence: raw },
    });
  }
  if (CAPPED_PROVENANCES.has(provenance)) {
    return Math.min(raw, AGENT_CONTRIBUTED_CONFIDENCE_CEILING);
  }
  return raw;
}

function validateProvenance(p: string): void {
  if (!PROVENANCE_VALUES.has(p)) {
    throw brainError("ledger_row_invalid", `unknown provenance: ${p}`);
  }
}

// ---------------------------------------------------------------------------
// Counterparty
// ---------------------------------------------------------------------------

export interface UpsertCounterpartyArgs {
  name: string;
  normalized_name?: string;
  type:
    | "merchant"
    | "vendor"
    | "customer"
    | "employer"
    | "bank"
    | "wallet"
    | "exchange"
    | "tax_authority"
    | "agent"
    | "other";
  /** For type="agent": the execution-layer agent id this counterparty is (RFC 0001). */
  agent_id?: string;
  /** Payee on-chain (EVM) address for x402/on-chain settlement (RFC 0001 §6.1). */
  onchain_address?: string;
  risk_level?: "low" | "medium" | "high" | "sanctioned";
  verified_status?: "unverified" | "self_attested" | "document_verified" | "sanctions_cleared";
  aliases?: string[];
  /** Off-chain structured context with no dedicated column (defaults to {}). */
  metadata?: Record<string, unknown>;
  source_ids: string[];
  evidence_ids: string[];
  provenance: string;
  confidence: number;
}

/**
 * Idempotent counterparty upsert. Dedup key: (owner_id, normalized_name, type).
 * If `normalized_name` isn't supplied, derives it from `name`.
 */
export async function upsertCounterpartyRow(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  args: UpsertCounterpartyArgs,
): Promise<{ row: CounterpartyRow; created: boolean }> {
  validateProvenance(args.provenance);
  const conf = cappedConfidence(args.provenance, args.confidence);
  const normalized = (args.normalized_name ?? normalizeName(args.name)).slice(0, 200);

  const result = await withTenantScope(pool, ctx.tenantId, async (c) => {
    const existing = await findByNormalizedName(c, normalized, args.type);
    if (existing !== null) {
      // Light merge: append new aliases + new source/evidence ids without
      // duplicates. Provenance/confidence don't downgrade here — that's a
      // dedicated promote/demote path.
      const aliases = mergeUnique(existing.aliases, args.aliases ?? []);
      const sourceIds = mergeUnique(existing.source_ids, args.source_ids);
      const evidenceIds = mergeUnique(existing.evidence_ids, args.evidence_ids);
      const { rows } = await c.query<CounterpartyRow>(
        `UPDATE ledger_counterparties
            SET aliases = $1,
                source_ids = $2,
                evidence_ids = $3,
                risk_level = COALESCE($4, risk_level),
                verified_status = COALESCE($5, verified_status),
                metadata = COALESCE($6::jsonb, metadata),
                updated_at = now()
          WHERE id = $7
          RETURNING *`,
        [
          aliases,
          sourceIds,
          evidenceIds,
          args.risk_level ?? null,
          args.verified_status ?? null,
          args.metadata !== undefined ? JSON.stringify(args.metadata) : null,
          existing.id,
        ],
      );
      return { row: rows[0]!, created: false };
    }
    const id = newCounterpartyId();
    const { rows } = await c.query<CounterpartyRow>(
      `INSERT INTO ledger_counterparties
         (id, owner_id, name, normalized_name, type, risk_level, verified_status,
          aliases, linked_accounts, source_ids, evidence_ids, provenance, confidence, agent_id,
          onchain_address, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,ARRAY[]::TEXT[],$9,$10,$11,$12,$13,$14,$15::jsonb)
       RETURNING *`,
      [
        id,
        ctx.tenantId,
        args.name,
        normalized,
        args.type,
        args.risk_level ?? null,
        args.verified_status ?? null,
        args.aliases ?? [],
        args.source_ids,
        args.evidence_ids,
        args.provenance,
        conf,
        args.agent_id ?? null,
        args.onchain_address ?? null,
        JSON.stringify(args.metadata ?? {}),
      ],
    );
    return { row: rows[0]!, created: true };
  });

  await audit.emit({
    tenantId: ctx.tenantId,
    layer: "ledger",
    actor: ctx.actor,
    action: result.created ? "ledger.counterparty.created" : "ledger.counterparty.merged",
    inputs: {
      name_hash: hashShort(args.name),
      type: args.type,
      provenance: args.provenance,
      source_ids: args.source_ids.slice(0, 5),
    },
    outputs: { counterparty_id: result.row.id, confidence: result.row.confidence },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface UpsertAccountArgs {
  external_account_id: string | null;
  institution?: string;
  account_type:
    | "bank_checking"
    | "bank_savings"
    | "card"
    | "loan"
    | "line_of_credit"
    | "onchain"
    | "payment_processor";
  name: string;
  currency: string;
  current_balance?: string | null;
  available_balance?: string | null;
  status: "active" | "closed" | "frozen" | "pending";
  source_ids: string[];
  evidence_ids: string[];
  provenance: string;
  confidence: number;
}

export async function upsertAccountRow(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  args: UpsertAccountArgs,
): Promise<{ row: AccountRow; created: boolean }> {
  validateProvenance(args.provenance);
  const conf = cappedConfidence(args.provenance, args.confidence);

  const result = await withTenantScope(pool, ctx.tenantId, async (c) => {
    if (args.external_account_id !== null) {
      const existing = await c.query<AccountRow>(
        `SELECT * FROM ledger_accounts WHERE external_account_id = $1 LIMIT 1`,
        [args.external_account_id],
      );
      if (existing.rows[0] !== undefined) {
        const prev = existing.rows[0];
        const sourceIds = mergeUnique(prev.source_ids, args.source_ids);
        const evidenceIds = mergeUnique(prev.evidence_ids, args.evidence_ids);
        const { rows } = await c.query<AccountRow>(
          `UPDATE ledger_accounts SET
             institution = COALESCE($1, institution),
             name = $2,
             current_balance = COALESCE($3, current_balance),
             available_balance = COALESCE($4, available_balance),
             status = $5,
             source_ids = $6,
             evidence_ids = $7,
             updated_at = now()
           WHERE id = $8
           RETURNING *`,
          [
            args.institution ?? null,
            args.name,
            args.current_balance ?? null,
            args.available_balance ?? null,
            args.status,
            sourceIds,
            evidenceIds,
            prev.id,
          ],
        );
        return { row: rows[0]!, created: false };
      }
    }

    const id = newAccountId();
    const { rows } = await c.query<AccountRow>(
      `INSERT INTO ledger_accounts
         (id, owner_id, institution, external_account_id, account_type, name,
          currency, current_balance, available_balance, status,
          source_ids, evidence_ids, provenance, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        id,
        ctx.tenantId,
        args.institution ?? null,
        args.external_account_id,
        args.account_type,
        args.name,
        args.currency,
        args.current_balance ?? null,
        args.available_balance ?? null,
        args.status,
        args.source_ids,
        args.evidence_ids,
        args.provenance,
        conf,
      ],
    );
    return { row: rows[0]!, created: true };
  });

  await audit.emit({
    tenantId: ctx.tenantId,
    layer: "ledger",
    actor: ctx.actor,
    action: result.created ? "ledger.account.created" : "ledger.account.updated",
    inputs: {
      external_account_id: args.external_account_id,
      account_type: args.account_type,
      provenance: args.provenance,
    },
    outputs: { account_id: result.row.id, status: result.row.status },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

export interface RecordTransactionArgs {
  account_id: string;
  external_transaction_id: string | null;
  amount: string; // non-negative decimal string
  currency: string;
  direction: "inflow" | "outflow" | "transfer" | "adjustment";
  transaction_date: string;
  posted_date?: string;
  counterparty_id?: string;
  category_id?: string;
  status: "pending" | "posted" | "cleared" | "failed" | "reversed" | "disputed";
  description_raw?: string;
  description_normalized?: string;
  source_ids: string[];
  evidence_ids: string[];
  provenance: string;
  confidence: number;
  /** On-chain settlement tx hash (0x…64 hex); set for on-chain txs (RFC 0001). */
  chain_tx_hash?: string;
}

/**
 * Idempotent transaction insert. Dedup key: (account_id, external_transaction_id).
 * Re-running with the same external id returns the existing row unchanged.
 */
export async function recordTransactionRow(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  args: RecordTransactionArgs,
): Promise<{ row: TransactionRow; created: boolean }> {
  validateProvenance(args.provenance);
  const conf = cappedConfidence(args.provenance, args.confidence);
  if (!/^\d+(\.\d+)?$/.test(args.amount)) {
    throw brainError("ledger_row_invalid", "amount must be non-negative decimal string", {
      details: { amount: args.amount },
    });
  }

  const result = await withTenantScope(pool, ctx.tenantId, async (c) => {
    if (args.external_transaction_id !== null) {
      const existing = await c.query<TransactionRow>(
        `SELECT * FROM ledger_transactions
          WHERE account_id = $1 AND external_transaction_id = $2
          LIMIT 1`,
        [args.account_id, args.external_transaction_id],
      );
      if (existing.rows[0] !== undefined) {
        return { row: existing.rows[0], created: false };
      }
    }

    const id = newTransactionId();
    const { rows } = await c.query<TransactionRow>(
      `INSERT INTO ledger_transactions
         (id, owner_id, account_id, external_transaction_id, amount, currency,
          direction, transaction_date, posted_date, counterparty_id, category_id,
          status, description_raw, description_normalized,
          source_ids, evidence_ids, reconciliation_status,
          provenance, confidence, chain_tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'unreconciled',$17,$18,$19)
       RETURNING *`,
      [
        id,
        ctx.tenantId,
        args.account_id,
        args.external_transaction_id,
        args.amount,
        args.currency,
        args.direction,
        args.transaction_date,
        args.posted_date ?? null,
        args.counterparty_id ?? null,
        args.category_id ?? null,
        args.status,
        args.description_raw ?? null,
        args.description_normalized ?? null,
        args.source_ids,
        args.evidence_ids,
        args.provenance,
        conf,
        args.chain_tx_hash ?? null,
      ],
    );
    return { row: rows[0]!, created: true };
  });

  await audit.emit({
    tenantId: ctx.tenantId,
    layer: "ledger",
    actor: ctx.actor,
    action: result.created ? "ledger.transaction.posted" : "ledger.transaction.deduplicated",
    inputs: {
      account_id: args.account_id,
      external_transaction_id: args.external_transaction_id,
      amount: args.amount,
      currency: args.currency,
      direction: args.direction,
      provenance: args.provenance,
    },
    outputs: { transaction_id: result.row.id },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Obligation
// ---------------------------------------------------------------------------

export interface UpsertObligationArgs {
  type:
    | "bill"
    | "invoice"
    | "subscription"
    | "loan"
    | "rent"
    | "payroll"
    | "tax"
    | "card_statement"
    | "other";
  counterparty_id: string;
  amount_due: string; // non-negative decimal string
  minimum_due?: string;
  currency: string;
  due_date: string; // ISO date-time
  recurrence?: string;
  status: "upcoming" | "due" | "paid" | "overdue" | "cancelled" | "disputed";
  /**
   * payable = we owe the counterparty (vendor side).
   * receivable = the counterparty owes us (customer side).
   * Optional so existing call sites keep compiling; when omitted the row
   * lands with direction = NULL and the §6 gate treats it as "direction
   * unknown" (no outflow→receivable check). Batch 10 H-1.
   */
  direction?: "payable" | "receivable";
  source_ids: string[];
  evidence_ids: string[];
  provenance: string;
  confidence: number;
}

/**
 * Idempotent obligation insert. The table carries no external id, so the
 * dedup key is (counterparty_id, type, amount_due, currency, due_date):
 * re-extracting the same document is a no-op. Like every writer here, the
 * agent-contributed confidence ceiling (§3.2) applies, so a document-derived
 * obligation lands at confidence <= 0.5.
 */
export async function upsertObligationRow(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  args: UpsertObligationArgs,
): Promise<{ row: ObligationRow; created: boolean }> {
  validateProvenance(args.provenance);
  const conf = cappedConfidence(args.provenance, args.confidence);
  if (!/^\d+(\.\d+)?$/.test(args.amount_due)) {
    throw brainError("ledger_row_invalid", "amount_due must be a non-negative decimal string", {
      details: { amount_due: args.amount_due },
    });
  }
  if (args.minimum_due !== undefined && !/^\d+(\.\d+)?$/.test(args.minimum_due)) {
    throw brainError("ledger_row_invalid", "minimum_due must be a non-negative decimal string", {
      details: { minimum_due: args.minimum_due },
    });
  }
  if (!/^[A-Z]{3}$/.test(args.currency)) {
    throw brainError("ledger_row_invalid", "currency must be a 3-letter ISO 4217 code", {
      details: { currency: args.currency },
    });
  }
  const dueDateIso = new Date(args.due_date);
  if (Number.isNaN(dueDateIso.getTime())) {
    throw brainError("ledger_row_invalid", "due_date must be a valid date-time", {
      details: { due_date: args.due_date },
    });
  }

  const result = await withTenantScope(pool, ctx.tenantId, async (c) => {
    const existing = await c.query<ObligationRow>(
      `SELECT * FROM ledger_obligations
        WHERE counterparty_id = $1 AND type = $2 AND amount_due = $3
          AND currency = $4 AND due_date = $5
        LIMIT 1`,
      [args.counterparty_id, args.type, args.amount_due, args.currency, dueDateIso.toISOString()],
    );
    if (existing.rows[0] !== undefined) {
      return { row: existing.rows[0], created: false };
    }

    const id = newObligationId();
    const { rows } = await c.query<ObligationRow>(
      `INSERT INTO ledger_obligations
         (id, owner_id, type, counterparty_id, amount_due, minimum_due, currency,
          due_date, recurrence, status, source_ids, evidence_ids, provenance, confidence,
          direction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        id,
        ctx.tenantId,
        args.type,
        args.counterparty_id,
        args.amount_due,
        args.minimum_due ?? null,
        args.currency,
        dueDateIso.toISOString(),
        args.recurrence ?? null,
        args.status,
        args.source_ids,
        args.evidence_ids,
        args.provenance,
        conf,
        args.direction ?? null,
      ],
    );
    return { row: rows[0]!, created: true };
  });

  await audit.emit({
    tenantId: ctx.tenantId,
    layer: "ledger",
    actor: ctx.actor,
    action: result.created ? "ledger.obligation.created" : "ledger.obligation.deduplicated",
    inputs: {
      counterparty_id: args.counterparty_id,
      type: args.type,
      amount_due: args.amount_due,
      currency: args.currency,
      provenance: args.provenance,
    },
    outputs: { obligation_id: result.row.id, confidence: result.row.confidence },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findByNormalizedName(
  c: TenantScopedClient,
  normalized: string,
  type: string,
): Promise<CounterpartyRow | null> {
  const { rows } = await c.query<CounterpartyRow>(
    `SELECT * FROM ledger_counterparties
      WHERE normalized_name = $1 AND type = $2
      LIMIT 1`,
    [normalized, type],
  );
  return rows[0] ?? null;
}

export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mergeUnique(a: ReadonlyArray<string>, b: ReadonlyArray<string>): string[] {
  const set = new Set<string>([...a, ...b]);
  return Array.from(set);
}

function hashShort(s: string): string {
  // 8-byte fingerprint for audit "inputs" — keeps the audit row compact
  // while still letting an investigator correlate by fingerprint.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
