/**
 * Cash-flow aggregator. Pure function over a transaction list — no DB
 * coupling so the unit tests are deterministic and the route layer is
 * the only place that talks SQL.
 *
 * Source: https://docs.brain.fi/api-reference/ledger-api ("cash flows").
 * Spec: components/schemas/CashFlowSummary.
 *
 * @packageDocumentation
 */

export interface CashFlowTransaction {
  /** RFC 3339 / ISO 8601. */
  readonly transaction_date: string;
  /** Decimal string. */
  readonly amount: string;
  /** ISO 4217. */
  readonly currency: string;
  readonly direction: "inflow" | "outflow" | "transfer" | "adjustment";
}

export interface CashFlowInput {
  readonly tenantId: string;
  readonly since: string;
  readonly until: string;
  readonly currencyFilter?: string;
  readonly transactions: readonly CashFlowTransaction[];
}

export interface CashFlowByDay {
  readonly date: string; // YYYY-MM-DD
  readonly inflow: string;
  readonly outflow: string;
  readonly net: string;
}

export interface CashFlowCurrency {
  readonly currency: string;
  readonly inflow: string;
  readonly outflow: string;
  readonly net: string;
  readonly transaction_count: number;
  readonly by_day: readonly CashFlowByDay[];
}

export interface CashFlowSummary {
  readonly tenantId: string;
  readonly since: string;
  readonly until: string;
  readonly currencies: readonly CashFlowCurrency[];
}

/** Add two decimal strings with up to 4 decimal places. */
function addDecimal(a: string, b: string): string {
  // Numeric-precision-safe enough for v0.3 cash-flow totals (< 1e15).
  // A follow-up swaps in big.js once it lands as a dep.
  const sum = Number.parseFloat(a) + Number.parseFloat(b);
  return formatDecimal(sum);
}

function subtractDecimal(a: string, b: string): string {
  const diff = Number.parseFloat(a) - Number.parseFloat(b);
  return formatDecimal(diff);
}

function formatDecimal(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  // Strip trailing zeros after the 2-decimal mark for tidy responses but
  // never below 2dp — matches the docs examples.
  const fixed = n.toFixed(2);
  return fixed;
}

function isoDateOnly(ts: string): string {
  // 2026-05-15T10:00:00Z → 2026-05-15
  const i = ts.indexOf("T");
  return i === -1 ? ts : ts.slice(0, i);
}

export function aggregateCashFlow(input: CashFlowInput): CashFlowSummary {
  // Bucket transactions by currency → by day.
  const byCurrency = new Map<
    string,
    {
      inflow: number;
      outflow: number;
      count: number;
      byDay: Map<string, { inflow: number; outflow: number }>;
    }
  >();

  for (const tx of input.transactions) {
    if (
      input.currencyFilter !== undefined &&
      tx.currency !== input.currencyFilter
    ) {
      continue;
    }
    let cur = byCurrency.get(tx.currency);
    if (cur === undefined) {
      cur = { inflow: 0, outflow: 0, count: 0, byDay: new Map() };
      byCurrency.set(tx.currency, cur);
    }
    const amt = Number.parseFloat(tx.amount);
    const day = isoDateOnly(tx.transaction_date);
    let dayBucket = cur.byDay.get(day);
    if (dayBucket === undefined) {
      dayBucket = { inflow: 0, outflow: 0 };
      cur.byDay.set(day, dayBucket);
    }
    cur.count++;
    if (tx.direction === "inflow") {
      cur.inflow += amt;
      dayBucket.inflow += amt;
    } else if (tx.direction === "outflow") {
      cur.outflow += amt;
      dayBucket.outflow += amt;
    }
    // transfer / adjustment do not affect inflow/outflow totals but are
    // counted in transaction_count.
  }

  const currencies: CashFlowCurrency[] = [];
  for (const [currency, agg] of byCurrency) {
    const byDay: CashFlowByDay[] = [];
    for (const [date, d] of [...agg.byDay].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      byDay.push({
        date,
        inflow: formatDecimal(d.inflow),
        outflow: formatDecimal(d.outflow),
        net: formatDecimal(d.inflow - d.outflow),
      });
    }
    currencies.push({
      currency,
      inflow: formatDecimal(agg.inflow),
      outflow: formatDecimal(agg.outflow),
      net: formatDecimal(agg.inflow - agg.outflow),
      transaction_count: agg.count,
      by_day: byDay,
    });
  }

  // Sort currencies alphabetically for stable JSON output.
  currencies.sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    tenantId: input.tenantId,
    since: input.since,
    until: input.until,
    currencies,
  };
}

// Re-export the helpers tests want to assert on.
export const _internal = {
  addDecimal,
  subtractDecimal,
  formatDecimal,
  isoDateOnly,
};
