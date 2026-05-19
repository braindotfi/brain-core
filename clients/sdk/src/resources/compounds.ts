import type { Brain } from "../brain.js";
import type { components } from "../generated/openapi.js";
import type { InclusionProof } from "./audit.js";

type Balance = components["schemas"]["Balance"];
type Transaction = components["schemas"]["Transaction"];
type Obligation = components["schemas"]["Obligation"];
type AuditEvent = components["schemas"]["AuditEvent"];

export interface FinancialSnapshot {
  balances: Balance[];
  recentTransactions: Transaction[];
  openObligations: Obligation[];
  asOf: string;
}

export interface TraceEntry {
  event: AuditEvent;
  inclusionProof: InclusionProof;
}

export interface ActionTrace {
  entityType: string;
  entityId: string;
  entries: TraceEntry[];
}

export interface CashFlowSummary {
  inflows: number;
  outflows: number;
  net: number;
  transactionCount: number;
  since: string;
  until: string;
  currency: string | undefined;
}

export interface SnapshotOptions {
  /** How many recent transactions to include. Default 20. */
  recentTransactionLimit?: number;
}

export interface CashFlowSummarizeParams {
  tenantId: string;
  since: string;
  until: string;
  currency?: string;
  accountId?: string;
}

/**
 * Client-side aggregations layered over the typed HTTP surface. None
 * of these methods correspond to a single REST endpoint — they
 * compose multiple calls (in parallel where possible) and reshape the
 * result for documented ergonomics.
 *
 * These are explicitly client-side: the server is not told about a
 * "snapshot" or "trace" — they're SDK conveniences. If a server-side
 * endpoint lands later, these can be retargeted without changing the
 * public method signature.
 */
export class CompoundsResource {
  constructor(private readonly brain: Brain) {}

  /**
   * Documented as `brain.snapshot(tenantId)` on docs.brain.fi.
   *
   * Returns a tenant's "right now" financial picture: latest balances
   * across all accounts, recent transactions, and any open obligations.
   * Runs in parallel.
   *
   * The `tenantId` argument matches the documented signature but is
   * not sent on the wire — the API derives tenant from the
   * authenticated principal. Reserved for future cross-tenant API key
   * support.
   */
  async snapshot(_tenantId: string, options: SnapshotOptions = {}): Promise<FinancialSnapshot> {
    const limit = options.recentTransactionLimit ?? 20;
    const [balances, transactionsPage, openObligations] = await Promise.all([
      this.brain.balances.list(),
      this.brain.transactions.list({ limit }),
      this.brain.obligations.list({ status: "due" }),
    ]);
    return {
      balances,
      recentTransactions: transactionsPage.transactions,
      openObligations,
      asOf: new Date().toISOString(),
    };
  }

  /**
   * Documented as `brain.trace(actionId)` on docs.brain.fi.
   *
   * Returns the full evidence chain for a PaymentIntent (or any other
   * Ledger entity). Steps:
   *   1. brain.audit.history(entityType, entityId) → list of events.
   *   2. brain.audit.get(eventId) for each → event + inclusion proof.
   *
   * Default entityType is `payment_intent` to match the docs example
   * `brain.trace(action.id)`. Override for other entity types.
   */
  async trace(
    entityId: string,
    options: {
      entityType?:
        | "payment_intent"
        | "transaction"
        | "execution"
        | "proposal"
        | "obligation"
        | "invoice"
        | "account"
        | "balance"
        | "counterparty"
        | "document"
        | "reconciliation_match";
    } = {},
  ): Promise<ActionTrace> {
    const entityType = options.entityType ?? "payment_intent";
    const history = await this.brain.audit.history(entityType, entityId);
    const entries = await Promise.all(
      history.events
        .filter((e): e is AuditEvent & { id: string } => typeof e.id === "string")
        .map(async (event) => {
          const detail = await this.brain.audit.get(event.id);
          return { event: detail.event, inclusionProof: detail.inclusionProof };
        }),
    );
    return {
      entityType,
      entityId,
      entries,
    };
  }
}

/**
 * `brain.cashFlow` namespace. Exposes one client-side aggregation:
 * `summarize`. Sums inflows and outflows over a date range. Future
 * methods (forecasts, period comparisons) hang off this namespace.
 */
export class CashFlowResource {
  constructor(private readonly brain: Brain) {}

  async summarize(params: CashFlowSummarizeParams): Promise<CashFlowSummary> {
    const txParams: NonNullable<Parameters<typeof this.brain.transactions.list>[0]> = {
      since: params.since,
      until: params.until,
    };
    if (params.accountId) txParams.account_id = params.accountId;

    let cursor: string | undefined = undefined;
    let inflows = 0;
    let outflows = 0;
    let transactionCount = 0;

    // Paginate through all transactions in the range.
    do {
      const page = await this.brain.transactions.list({
        ...txParams,
        ...(cursor ? { cursor } : {}),
      });
      for (const tx of page.transactions) {
        const amount = parseAmount(tx);
        if (amount === undefined) continue;
        transactionCount += 1;
        if (tx.direction === "inflow") inflows += amount;
        else if (tx.direction === "outflow") outflows += amount;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    return {
      inflows,
      outflows,
      net: inflows - outflows,
      transactionCount,
      since: params.since,
      until: params.until,
      currency: params.currency,
    };
  }
}

function parseAmount(tx: Transaction): number | undefined {
  const raw = (tx as { amount?: string | number }).amount;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
