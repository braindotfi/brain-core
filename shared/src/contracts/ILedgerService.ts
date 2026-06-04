/**
 * ILedgerService — Layer 2 boundary contract.
 *
 * Owns the eleven Ledger entities. Read-side: the public API. Write-side:
 * controlled methods that the extractor pipeline (Phase 3 onwards) and the
 * /wiki/annotate write-through path call. No external code mutates Ledger
 * tables outside this service.
 *
 * Layer boundary invariants:
 *  - Every write originates from Raw evidence (source_ids + evidence_ids
 *    populated) OR from a controlled annotation path that itself wrote a
 *    Raw artifact.
 *  - Agent-contributed rows are capped at confidence 0.5.
 *  - Every write emits a corresponding audit event.
 *  - The service NEVER reads from the Wiki layer.
 *  - The service NEVER executes a payment; PaymentIntent is owned here as
 *    a lifecycle marker, but the §6 gate + execution live in the Agent
 *    layer.
 */

import type {
  LedgerCommonFields,
  ListResult,
  ServiceCallContext,
  Currency,
  DecimalString,
} from "./types.js";

// ---------- Entity shapes -------------------------------------------------

export interface Account extends LedgerCommonFields {
  institution: string | null;
  external_account_id: string | null;
  account_type: "bank_checking" | "bank_savings" | "card" | "loan" | "line_of_credit" | "onchain";
  name: string;
  currency: Currency;
  current_balance: DecimalString | null;
  available_balance: DecimalString | null;
  status: "active" | "closed" | "frozen" | "pending";
}

export interface Balance extends LedgerCommonFields {
  account_id: string;
  as_of: string;
  current_balance: DecimalString;
  available_balance: DecimalString | null;
  pending_balance: DecimalString | null;
  currency: Currency;
}

export interface Transaction extends LedgerCommonFields {
  account_id: string;
  external_transaction_id: string | null;
  amount: DecimalString;
  currency: Currency;
  direction: "inflow" | "outflow" | "transfer" | "adjustment";
  transaction_date: string;
  posted_date: string | null;
  counterparty_id: string | null;
  category_id: string | null;
  status: "pending" | "posted" | "cleared" | "failed" | "reversed" | "disputed";
  description_raw: string | null;
  description_normalized: string | null;
  reconciliation_status: "unreconciled" | "matched" | "partial" | "disputed" | null;
}

export interface Counterparty extends LedgerCommonFields {
  name: string;
  normalized_name: string | null;
  type:
    | "merchant"
    | "vendor"
    | "customer"
    | "employer"
    | "bank"
    | "wallet"
    | "exchange"
    | "tax_authority"
    // A payee that is itself a registered Brain agent (M2M / x402, RFC 0001 §6.3).
    | "agent"
    | "other";
  risk_level: "low" | "medium" | "high" | "sanctioned" | null;
  verified_status:
    | "unverified"
    | "self_attested"
    | "document_verified"
    | "sanctions_cleared"
    | null;
  aliases: string[];
  linked_accounts: string[];
  /** For type="agent": the execution-layer agent id (RFC 0001 §6.3); null otherwise. */
  agent_id: string | null;
  /** Payee on-chain (EVM) address for x402/on-chain settlement (RFC 0001 §6.1); null off-chain. */
  onchain_address: string | null;
  /** Tenant-scoped, off-chain structured context with no dedicated column. Defaults to {}. */
  metadata: Record<string, unknown>;
}

export interface Obligation extends LedgerCommonFields {
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
  amount_due: DecimalString;
  minimum_due: DecimalString | null;
  currency: Currency;
  due_date: string;
  recurrence: string | null;
  status: "upcoming" | "due" | "paid" | "overdue" | "cancelled" | "disputed";
  linked_transaction_ids: string[];
}

export interface Document extends LedgerCommonFields {
  document_type:
    | "invoice"
    | "receipt"
    | "bank_statement"
    | "card_statement"
    | "contract"
    | "payroll"
    | "tax"
    | "other";
  source_uri: string | null;
  extracted_fields: Record<string, unknown>;
  linked_account_ids: string[];
  linked_transaction_ids: string[];
  linked_obligation_ids: string[];
  confidence_score: number | null;
}

export interface Category {
  id: string;
  owner_id: string;
  name: string;
  parent_id: string | null;
  kind: "expense" | "income" | "transfer" | "other";
  created_at: string;
  updated_at: string;
}

export interface Transfer extends LedgerCommonFields {
  from_account_id: string;
  to_account_id: string;
  from_transaction_id: string | null;
  to_transaction_id: string | null;
  amount: DecimalString;
  currency: Currency;
  transfer_date: string;
  status: "proposed" | "in_flight" | "completed" | "failed";
}

export interface Invoice extends LedgerCommonFields {
  invoice_number: string;
  counterparty_id: string;
  amount_due: DecimalString;
  amount_paid: DecimalString;
  currency: Currency;
  issue_date: string;
  due_date: string | null;
  status: "draft" | "sent" | "partial" | "paid" | "overdue" | "cancelled" | "disputed";
  linked_document_ids: string[];
  linked_transaction_ids: string[];
  /** Tenant-scoped, off-chain structured context with no dedicated column. Defaults to {}. */
  metadata: Record<string, unknown>;
}

// ---------- Filter types --------------------------------------------------

export interface AccountListFilters {
  status?: Account["status"];
  account_type?: Account["account_type"];
  limit?: number;
  cursor?: string;
}

export interface TransactionListFilters {
  account_id?: string;
  counterparty_id?: string;
  direction?: Transaction["direction"];
  status?: Transaction["status"];
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface ObligationListFilters {
  status?: Obligation["status"];
  type?: Obligation["type"];
  due_before?: string;
  limit?: number;
  cursor?: string;
}

// ---------- Write inputs --------------------------------------------------

export interface UpsertAccountInput {
  external_account_id: string | null;
  institution?: string;
  account_type: Account["account_type"];
  name: string;
  currency: Currency;
  current_balance?: DecimalString | null;
  available_balance?: DecimalString | null;
  status: Account["status"];
  source_ids: string[];
  evidence_ids: string[];
  provenance: Account["provenance"];
  confidence: number;
}

export interface RecordTransactionInput {
  account_id: string;
  external_transaction_id: string | null;
  amount: DecimalString;
  currency: Currency;
  direction: Transaction["direction"];
  transaction_date: string;
  posted_date?: string;
  counterparty_id?: string;
  category_id?: string;
  status: Transaction["status"];
  description_raw?: string;
  description_normalized?: string;
  source_ids: string[];
  evidence_ids: string[];
  provenance: Transaction["provenance"];
  confidence: number;
}

export interface UpsertCounterpartyInput {
  name: string;
  normalized_name?: string;
  type: Counterparty["type"];
  risk_level?: Counterparty["risk_level"];
  verified_status?: Counterparty["verified_status"];
  aliases?: string[];
  source_ids: string[];
  evidence_ids: string[];
  provenance: Counterparty["provenance"];
  confidence: number;
}

// ---------- The interface -------------------------------------------------

export interface ILedgerService {
  // Reads
  listAccounts(ctx: ServiceCallContext, f: AccountListFilters): Promise<ListResult<Account>>;
  getAccount(
    ctx: ServiceCallContext,
    id: string,
  ): Promise<{ account: Account; latest_balance: Balance | null } | null>;
  listTransactions(
    ctx: ServiceCallContext,
    f: TransactionListFilters,
  ): Promise<ListResult<Transaction>>;
  getTransaction(ctx: ServiceCallContext, id: string): Promise<Transaction | null>;
  listCounterparties(
    ctx: ServiceCallContext,
    f: { q?: string; type?: Counterparty["type"]; limit?: number },
  ): Promise<ListResult<Counterparty>>;
  listObligations(
    ctx: ServiceCallContext,
    f: ObligationListFilters,
  ): Promise<ListResult<Obligation>>;
  listInvoices(
    ctx: ServiceCallContext,
    f: { status?: Invoice["status"]; counterparty_id?: string; limit?: number },
  ): Promise<ListResult<Invoice>>;
  listDocuments(
    ctx: ServiceCallContext,
    f: { document_type?: Document["document_type"]; limit?: number },
  ): Promise<ListResult<Document>>;
  listBalances(
    ctx: ServiceCallContext,
    f: { account_id?: string; as_of?: string },
  ): Promise<Balance[]>;

  // Writes — invoked by the extractor pipeline (Phase 3+) and annotation
  // path. Each method is idempotent per (tenant, source-driven dedup key)
  // and emits an audit event of the form `ledger.<entity>.<verb>`.
  upsertAccount(ctx: ServiceCallContext, input: UpsertAccountInput): Promise<Account>;
  recordTransaction(ctx: ServiceCallContext, input: RecordTransactionInput): Promise<Transaction>;
  upsertCounterparty(
    ctx: ServiceCallContext,
    input: UpsertCounterpartyInput,
  ): Promise<Counterparty>;

  /** Idempotent re-normalization. Used by the extractor pipeline retry path. */
  normalizeFromRaw(
    ctx: ServiceCallContext,
    rawParsedId: string,
  ): Promise<{ created: Array<{ entity: string; id: string }> }>;
}
