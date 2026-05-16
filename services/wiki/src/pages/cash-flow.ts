/**
 * /cash-flow/{period} — page generator.
 *
 * Period formats:
 *   YYYY-MM   (monthly, e.g. "2026-05")
 *   YYYY-QN   (quarterly, e.g. "2026-Q2")
 *
 * Renders an inflow/outflow/net summary for the period, the top counterparties
 * by volume, significant individual transactions, and upcoming obligations
 * that fall within the period.
 */

import type { PageGenerationContext, PageGenerationOutput, PageGenerator } from "./types.js";
import { bullet, renderPage, revisionFromTouches } from "./sections.js";

export class CashFlowPageGenerator implements PageGenerator {
  public readonly pageType = "cash_flow" as const;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (slugOrId.startsWith("/cash-flow/")) {
      const period = slugOrId.slice("/cash-flow/".length);
      if (!isValidPeriod(period)) return null;
      return { subjectId: period, slug: slugOrId };
    }
    if (isValidPeriod(slugOrId)) {
      return { subjectId: slugOrId, slug: `/cash-flow/${slugOrId}` };
    }
    return null;
  }

  public async render(
    deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    const period = subject.subjectId;
    if (period === null) throw new Error("CashFlowPageGenerator requires a period");

    const { start, end, label } = parsePeriod(period);

    const [summary, topCounterparties, recentTxRows, obligations] = await Promise.all([
      fetchCashFlowSummary(deps, start, end),
      fetchTopCounterparties(deps, start, end),
      fetchLargestTransactions(deps, start, end),
      fetchObligationsDue(deps, start, end),
    ]);

    const net = summary.inflow - summary.outflow;
    const netStr = net >= 0 ? `+${net.toFixed(2)}` : net.toFixed(2);

    const currentTruth =
      `**Cash Flow · ${label}**\n` +
      `Inflows: ${summary.inflow.toFixed(2)} ${summary.currency ?? "USD"} (${summary.inflowCount} tx)\n` +
      `Outflows: ${summary.outflow.toFixed(2)} ${summary.currency ?? "USD"} (${summary.outflowCount} tx)\n` +
      `Net: ${netStr} ${summary.currency ?? "USD"}`;

    const linkedEntities = bullet(
      [
        ...topCounterparties.inflow.slice(0, 3).map(
          (cp) => `Top inflow: **${cp.name}** \`${cp.id}\` — ${cp.total.toFixed(2)} ${summary.currency ?? "USD"}`,
        ),
        ...topCounterparties.outflow.slice(0, 3).map(
          (cp) => `Top outflow: **${cp.name}** \`${cp.id}\` — ${cp.total.toFixed(2)} ${summary.currency ?? "USD"}`,
        ),
      ],
      "_No counterparty data._",
    );

    const recentActivity = bullet(
      recentTxRows.map(
        (t) =>
          `${t.transaction_date.toISOString().slice(0, 10)} — ${t.direction} ${t.amount} ${t.currency}` +
          (t.description_normalized !== null ? ` — "${t.description_normalized}"` : "") +
          ` (\`${t.id}\`)`,
      ),
      "_No significant transactions._",
    );

    const overdueObls = obligations.filter((o) => o.status === "overdue");
    const openQuestions =
      overdueObls.length > 0
        ? `${overdueObls.length} overdue obligation(s) due in this period remain unpaid. Review reconciliation status.`
        : net < 0
          ? "Net cash outflow for this period. Review top outflow counterparties."
          : "_None._";

    const riskNotes =
      net < 0
        ? `Negative net cash flow: ${netStr} ${summary.currency ?? "USD"}. Ensure operating reserves are sufficient.`
        : "_No risk flags._";

    const timeline = bullet(
      obligations
        .slice(0, 8)
        .map(
          (o) =>
            `${o.due_date.toISOString().slice(0, 10)} — ${o.type} ${o.amount_due} ${o.currency} (\`${o.id}\`) [${o.status}]`,
        ),
      "_No obligations due in this period._",
    );

    const revision = revisionFromTouches(
      recentTxRows.map((t) => ({ id: t.id, updated_at: t.transaction_date })),
    );

    return {
      page_type: this.pageType,
      subject_id: period,
      slug: subject.slug,
      body_md: renderPage(`Cash Flow · ${label}`, {
        currentTruth,
        linkedEntities,
        recentActivity,
        openQuestions,
        riskNotes,
        timeline,
      }),
      source_revision: revision !== "" ? revision : `cashflow_${period}`,
    };
  }
}

// ---------- Helpers ----------------------------------------------------------

function isValidPeriod(s: string): boolean {
  return /^\d{4}-\d{2}$/.test(s) || /^\d{4}-Q[1-4]$/.test(s);
}

function parsePeriod(period: string): { start: Date; end: Date; label: string } {
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarterMatch !== null) {
    const year = parseInt(quarterMatch[1]!, 10);
    const q = parseInt(quarterMatch[2]!, 10);
    const startMonth = (q - 1) * 3;
    const start = new Date(Date.UTC(year, startMonth, 1));
    const end = new Date(Date.UTC(year, startMonth + 3, 1));
    return { start, end, label: `${year} Q${q}` };
  }
  const [yearStr, monthStr] = period.split("-") as [string, string];
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1;
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const monthName = start.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return { start, end, label: `${monthName} ${year}` };
}

// ---------- Queries ----------------------------------------------------------

interface SummaryRow {
  inflow: number;
  outflow: number;
  inflowCount: number;
  outflowCount: number;
  currency: string | null;
}

async function fetchCashFlowSummary(
  deps: PageGenerationContext,
  start: Date,
  end: Date,
): Promise<SummaryRow> {
  const { rows } = await deps.client.query<{
    direction: string;
    total: string;
    cnt: string;
    currency: string;
  }>(
    `SELECT direction,
            SUM(amount)::TEXT AS total,
            COUNT(*)::TEXT AS cnt,
            MAX(currency) AS currency
       FROM ledger_transactions
      WHERE status IN ('posted','cleared')
        AND transaction_date >= $1
        AND transaction_date < $2
        AND direction IN ('inflow','outflow')
      GROUP BY direction`,
    [start, end],
  );

  let inflow = 0;
  let outflow = 0;
  let inflowCount = 0;
  let outflowCount = 0;
  let currency: string | null = null;
  for (const r of rows) {
    if (r.direction === "inflow") {
      inflow = parseFloat(r.total);
      inflowCount = parseInt(r.cnt, 10);
    } else {
      outflow = parseFloat(r.total);
      outflowCount = parseInt(r.cnt, 10);
    }
    currency = currency ?? r.currency;
  }
  return { inflow, outflow, inflowCount, outflowCount, currency };
}

interface CounterpartyVolume {
  id: string;
  name: string;
  total: number;
}

async function fetchTopCounterparties(
  deps: PageGenerationContext,
  start: Date,
  end: Date,
): Promise<{ inflow: CounterpartyVolume[]; outflow: CounterpartyVolume[] }> {
  const { rows } = await deps.client.query<{
    direction: string;
    counterparty_id: string;
    name: string;
    total: string;
  }>(
    `SELECT t.direction,
            t.counterparty_id,
            COALESCE(cp.name, t.counterparty_id) AS name,
            SUM(t.amount)::TEXT AS total
       FROM ledger_transactions t
       LEFT JOIN ledger_counterparties cp ON cp.id = t.counterparty_id
      WHERE t.status IN ('posted','cleared')
        AND t.transaction_date >= $1
        AND t.transaction_date < $2
        AND t.direction IN ('inflow','outflow')
        AND t.counterparty_id IS NOT NULL
      GROUP BY t.direction, t.counterparty_id, cp.name
      ORDER BY SUM(t.amount) DESC
      LIMIT 20`,
    [start, end],
  );

  const inflow: CounterpartyVolume[] = [];
  const outflow: CounterpartyVolume[] = [];
  for (const r of rows) {
    const entry = { id: r.counterparty_id, name: r.name, total: parseFloat(r.total) };
    if (r.direction === "inflow") inflow.push(entry);
    else outflow.push(entry);
  }
  return { inflow, outflow };
}

interface TxRow {
  id: string;
  amount: string;
  currency: string;
  direction: string;
  transaction_date: Date;
  description_normalized: string | null;
}

async function fetchLargestTransactions(
  deps: PageGenerationContext,
  start: Date,
  end: Date,
): Promise<TxRow[]> {
  const { rows } = await deps.client.query<TxRow>(
    `SELECT id, amount::TEXT, currency, direction, transaction_date, description_normalized
       FROM ledger_transactions
      WHERE status IN ('posted','cleared')
        AND transaction_date >= $1
        AND transaction_date < $2
        AND direction IN ('inflow','outflow')
      ORDER BY amount DESC
      LIMIT 10`,
    [start, end],
  );
  return rows;
}

interface ObligationRow {
  id: string;
  type: string;
  amount_due: string;
  currency: string;
  due_date: Date;
  status: string;
}

async function fetchObligationsDue(
  deps: PageGenerationContext,
  start: Date,
  end: Date,
): Promise<ObligationRow[]> {
  const { rows } = await deps.client.query<ObligationRow>(
    `SELECT id, type, amount_due::TEXT, currency, due_date, status
       FROM ledger_obligations
      WHERE due_date >= $1
        AND due_date < $2
      ORDER BY due_date ASC
      LIMIT 20`,
    [start, end],
  );
  return rows;
}
