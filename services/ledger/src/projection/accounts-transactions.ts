import type { Pool } from "pg";
import {
  leasedCycle,
  newAccountId,
  newTransactionId,
  startManagedInterval,
  withTenantScope,
  type ManagedWorker,
  type MetricsEmitter,
  type TenantScopedClient,
} from "@brain/shared";

const DEFAULT_CONFIDENCE: Readonly<Record<string, number>> = {
  extracted: 0.9,
  human_confirmed: 1.0,
  agent_contributed: 0.5,
  customer_asserted: 0.5,
};

interface CanonicalAccountRow {
  id: string;
  tenant_id: string;
  institution: string | null;
  external_account_id: string | null;
  account_type: string;
  name: string;
  currency: string;
  current_balance: string | null;
  available_balance: string | null;
  status: string;
  provenance: string;
  confidence: number | null;
  source_ids: string[];
  evidence_ids: string[];
}

interface CanonicalTransactionRow {
  id: string;
  tenant_id: string;
  canonical_account_id: string | null;
  canonical_counterparty_id: string | null;
  source_natural_key: string;
  amount: string;
  currency: string;
  direction: string;
  transaction_date: string;
  posted_date: string | null;
  status: string;
  description_raw: string | null;
  description_normalized: string | null;
  reconciliation_status: string | null;
  provenance: string;
  confidence: number | null;
  source_ids: string[];
  evidence_ids: string[];
}

function projectedConfidence(provenance: string, confidence: number | null): number {
  const base = confidence ?? DEFAULT_CONFIDENCE[provenance] ?? 0.5;
  return provenance === "agent_contributed" || provenance === "customer_asserted"
    ? Math.min(base, 0.5)
    : base;
}

export async function projectCanonicalAccount(
  c: TenantScopedClient,
  tenantId: string,
  row: CanonicalAccountRow,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO ledger_accounts
       (id, owner_id, institution, external_account_id, account_type, name, currency,
        current_balance, available_balance, status, source_ids, evidence_ids,
        provenance, confidence, canonical_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],$13,$14,$15)
     ON CONFLICT (owner_id, external_account_id) DO UPDATE SET
        canonical_account_id = COALESCE(
          ledger_accounts.canonical_account_id,
          EXCLUDED.canonical_account_id
        ),
        institution = EXCLUDED.institution,
        account_type = EXCLUDED.account_type,
        name = CASE WHEN ledger_accounts.provenance = 'human_confirmed'
                    THEN ledger_accounts.name ELSE EXCLUDED.name END,
        currency = EXCLUDED.currency,
        current_balance = EXCLUDED.current_balance,
        available_balance = EXCLUDED.available_balance,
        status = EXCLUDED.status,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        provenance = CASE WHEN ledger_accounts.provenance = 'human_confirmed'
                          THEN ledger_accounts.provenance ELSE EXCLUDED.provenance END,
        confidence = GREATEST(ledger_accounts.confidence, EXCLUDED.confidence),
        updated_at = now()
     RETURNING id`,
    [
      newAccountId(),
      tenantId,
      row.institution,
      row.external_account_id ?? row.id,
      row.account_type,
      row.name,
      row.currency,
      row.current_balance,
      row.available_balance,
      row.status,
      row.source_ids,
      row.evidence_ids,
      row.provenance,
      projectedConfidence(row.provenance, row.confidence),
      row.id,
    ],
  );
  const out = rows[0];
  if (out === undefined) throw new Error("projectCanonicalAccount returned no row");
  return out.id;
}

export async function projectCanonicalTransaction(
  c: TenantScopedClient,
  tenantId: string,
  row: CanonicalTransactionRow,
): Promise<boolean> {
  if (row.canonical_account_id === null) return false;
  const { rows: accounts } = await c.query<{ id: string }>(
    `SELECT id FROM ledger_accounts
      WHERE owner_id = $1 AND canonical_account_id = $2`,
    [tenantId, row.canonical_account_id],
  );
  const accountId = accounts[0]?.id;
  if (accountId === undefined) return false;

  const counterpartyId =
    row.canonical_counterparty_id === null
      ? null
      : ((
          await c.query<{ id: string }>(
            `SELECT id FROM ledger_counterparties
              WHERE owner_id = $1 AND canonical_counterparty_id = $2`,
            [tenantId, row.canonical_counterparty_id],
          )
        ).rows[0]?.id ?? null);

  await c.query(
    `INSERT INTO ledger_transactions
       (id, owner_id, account_id, external_transaction_id, amount, currency, direction,
        transaction_date, posted_date, counterparty_id, status, description_raw,
        description_normalized, source_ids, evidence_ids, reconciliation_status,
        provenance, confidence, canonical_transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text[],$15::text[],$16,$17,$18,$19)
     ON CONFLICT (account_id, external_transaction_id) DO UPDATE SET
        canonical_transaction_id = COALESCE(
          ledger_transactions.canonical_transaction_id,
          EXCLUDED.canonical_transaction_id
        ),
        amount = EXCLUDED.amount,
        currency = EXCLUDED.currency,
        direction = EXCLUDED.direction,
        transaction_date = EXCLUDED.transaction_date,
        posted_date = EXCLUDED.posted_date,
        counterparty_id = COALESCE(EXCLUDED.counterparty_id, ledger_transactions.counterparty_id),
        status = EXCLUDED.status,
        description_raw = EXCLUDED.description_raw,
        description_normalized = EXCLUDED.description_normalized,
        source_ids = EXCLUDED.source_ids,
        evidence_ids = EXCLUDED.evidence_ids,
        reconciliation_status = COALESCE(
          ledger_transactions.reconciliation_status,
          EXCLUDED.reconciliation_status
        ),
        provenance = CASE WHEN ledger_transactions.provenance = 'human_confirmed'
                          THEN ledger_transactions.provenance ELSE EXCLUDED.provenance END,
        confidence = GREATEST(ledger_transactions.confidence, EXCLUDED.confidence),
        updated_at = now()`,
    [
      newTransactionId(),
      tenantId,
      accountId,
      row.source_natural_key,
      row.amount,
      row.currency,
      row.direction,
      row.transaction_date,
      row.posted_date,
      counterpartyId,
      row.status,
      row.description_raw,
      row.description_normalized,
      row.source_ids,
      row.evidence_ids,
      row.reconciliation_status,
      row.provenance,
      projectedConfidence(row.provenance, row.confidence),
      row.id,
    ],
  );
  return true;
}

export interface AccountTransactionRebuildResult {
  accounts: number;
  transactions: number;
}

export async function rebuildAccountTransactionProjectionFromCanonical(
  pool: Pool,
  tenantId: string,
): Promise<AccountTransactionRebuildResult> {
  return withTenantScope(pool, tenantId, async (c) => {
    const { rows: accounts } = await c.query<CanonicalAccountRow>(
      `SELECT id, tenant_id, institution, external_account_id, account_type, name, currency,
              current_balance, available_balance, status, provenance, confidence,
              source_ids, evidence_ids
         FROM canonical_account
        WHERE tenant_id = $1`,
      [tenantId],
    );
    for (const account of accounts) await projectCanonicalAccount(c, tenantId, account);

    const { rows: transactions } = await c.query<CanonicalTransactionRow>(
      `SELECT id, tenant_id, canonical_account_id, canonical_counterparty_id,
              source_natural_key, amount, currency, direction, transaction_date, posted_date,
              status, description_raw, description_normalized, reconciliation_status,
              provenance, confidence, source_ids, evidence_ids
         FROM canonical_transaction
        WHERE tenant_id = $1`,
      [tenantId],
    );
    let transactionCount = 0;
    for (const transaction of transactions) {
      if (await projectCanonicalTransaction(c, tenantId, transaction)) transactionCount += 1;
    }
    return { accounts: accounts.length, transactions: transactionCount };
  });
}

export interface LedgerAccountTransactionProjectionWorkerDeps {
  pool: Pool;
  metrics?: MetricsEmitter;
}

export interface LedgerAccountTransactionProjectionWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
}

export type LedgerAccountTransactionProjectionWorker = ManagedWorker;

export async function runLedgerAccountTransactionProjectionCycle(
  deps: LedgerAccountTransactionProjectionWorkerDeps,
  opts?: LedgerAccountTransactionProjectionWorkerOptions,
): Promise<void> {
  const batchSize = opts?.batchSize ?? 50;
  try {
    const { rows: accounts } = await deps.pool.query<CanonicalAccountRow>(
      `SELECT ca.id, ca.tenant_id, ca.institution, ca.external_account_id, ca.account_type,
              ca.name, ca.currency, ca.current_balance, ca.available_balance, ca.status,
              ca.provenance, ca.confidence, ca.source_ids, ca.evidence_ids
         FROM canonical_account ca
         LEFT JOIN ledger_accounts la
           ON la.owner_id = ca.tenant_id AND la.canonical_account_id = ca.id
        WHERE la.id IS NULL OR la.updated_at < ca.updated_at
        ORDER BY ca.updated_at ASC
        LIMIT $1`,
      [batchSize],
    );
    for (const account of accounts) {
      await withTenantScope(deps.pool, account.tenant_id, (c) =>
        projectCanonicalAccount(c, account.tenant_id, account),
      );
    }
    if (accounts.length > 0) {
      deps.metrics?.increment(
        "brain.ledger.account_transaction_projection.records.count",
        {
          type: "account",
        },
        accounts.length,
      );
    }
  } catch (err) {
    console.error("[ledgerAccountTransactionProjector] account cycle failed:", err);
  }

  try {
    const { rows: transactions } = await deps.pool.query<CanonicalTransactionRow>(
      `SELECT ct.id, ct.tenant_id, ct.canonical_account_id, ct.canonical_counterparty_id,
              ct.source_natural_key, ct.amount, ct.currency, ct.direction, ct.transaction_date,
              ct.posted_date, ct.status, ct.description_raw, ct.description_normalized,
              ct.reconciliation_status, ct.provenance, ct.confidence, ct.source_ids,
              ct.evidence_ids
         FROM canonical_transaction ct
         LEFT JOIN ledger_transactions lt
           ON lt.owner_id = ct.tenant_id AND lt.canonical_transaction_id = ct.id
        WHERE lt.id IS NULL OR lt.updated_at < ct.updated_at
        ORDER BY ct.updated_at ASC
        LIMIT $1`,
      [batchSize],
    );
    let projected = 0;
    for (const transaction of transactions) {
      const ok = await withTenantScope(deps.pool, transaction.tenant_id, (c) =>
        projectCanonicalTransaction(c, transaction.tenant_id, transaction),
      );
      if (ok) projected += 1;
    }
    if (projected > 0) {
      deps.metrics?.increment(
        "brain.ledger.account_transaction_projection.records.count",
        { type: "transaction" },
        projected,
      );
    }
  } catch (err) {
    console.error("[ledgerAccountTransactionProjector] transaction cycle failed:", err);
  }
}

export function startLedgerAccountTransactionProjectionWorker(
  deps: LedgerAccountTransactionProjectionWorkerDeps,
  opts?: LedgerAccountTransactionProjectionWorkerOptions,
): LedgerAccountTransactionProjectionWorker {
  const intervalMs = opts?.intervalMs ?? 15_000;
  return startManagedInterval(
    leasedCycle({
      pool: deps.pool,
      lockKey: "brain_worker_ledger_account_transaction_projection",
      cycle: () => runLedgerAccountTransactionProjectionCycle(deps, opts),
      name: "ledger-account-transaction-projection",
      metrics: deps.metrics,
    }),
    intervalMs,
    {
      name: "ledger-account-transaction-projection",
      runImmediately: true,
      onError: (err) => console.error("[ledgerAccountTransactionProjector] cycle failed:", err),
    },
  );
}
