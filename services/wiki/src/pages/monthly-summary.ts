/**
 * /monthly-summaries/{YYYY-MM} — page generator.
 *
 * Aggregates inflow / outflow / open obligations for a calendar month,
 * with the top counterparties by activity. Read entirely from the Ledger.
 */

import type { PageGenerationContext, PageGenerationOutput, PageGenerator } from "./types.js";
import { bullet, renderPage, revisionFromTouches } from "./sections.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export class MonthlySummaryPageGenerator implements PageGenerator {
  public readonly pageType = "monthly_summary" as const;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (MONTH_RE.test(slugOrId))
      return { subjectId: slugOrId, slug: `/monthly-summaries/${slugOrId}` };
    if (slugOrId.startsWith("/monthly-summaries/")) {
      const id = slugOrId.slice("/monthly-summaries/".length);
      if (!MONTH_RE.test(id)) return null;
      return { subjectId: id, slug: slugOrId };
    }
    return null;
  }

  public async render(
    deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    const month = subject.subjectId;
    if (month === null || !MONTH_RE.test(month)) {
      throw new Error("MonthlySummaryPageGenerator requires a YYYY-MM subject");
    }
    const start = new Date(`${month}-01T00:00:00Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);

    const [totals, topInflow, topOutflow, dueSoon, lastTouches] = await Promise.all([
      fetchTotals(deps, start, end),
      fetchTopCounterparties(deps, start, end, "inflow"),
      fetchTopCounterparties(deps, start, end, "outflow"),
      fetchObligationsDueIn(deps, start, end),
      fetchLastTouches(deps, start, end),
    ]);

    const currentTruth =
      `**Month: ${month}**\n` +
      `Inflow total: \`${totals.inflow ?? "0.00"}\`\n` +
      `Outflow total: \`${totals.outflow ?? "0.00"}\`\n` +
      `Net: \`${netDecimal(totals.inflow, totals.outflow)}\`\n` +
      `Tx count: ${totals.tx_count}\n`;

    const linkedEntities = bullet(
      [
        ...topInflow
          .slice(0, 5)
          .map((c) => `Top inflow: ${c.name} \`${c.id}\` — ${c.total} ${c.currency}`),
        ...topOutflow
          .slice(0, 5)
          .map((c) => `Top outflow: ${c.name} \`${c.id}\` — ${c.total} ${c.currency}`),
      ],
      "_No counterparties active this month._",
    );

    const recentActivity = bullet(
      lastTouches.map(
        (t) =>
          `${t.transaction_date.toISOString().slice(0, 10)} — ${t.direction} ${t.amount} ${t.currency} ` +
          (t.counterparty_id !== null ? `to/from \`${t.counterparty_id}\`` : ""),
      ),
      "_No transactions in window._",
    );

    const openQuestions = bullet(
      dueSoon
        .filter((o) => o.status === "overdue")
        .map(
          (o) =>
            `Overdue: ${o.type} ${o.amount_due} ${o.currency} due ${o.due_date.toISOString().slice(0, 10)} — \`${o.id}\``,
        ),
      "_No overdue obligations in window._",
    );

    const timeline = bullet(
      dueSoon.map(
        (o) =>
          `${o.due_date.toISOString().slice(0, 10)} — ${o.type} (${o.status}) ${o.amount_due} ${o.currency} → \`${o.id}\``,
      ),
      "_No obligations due in window._",
    );

    const revision = revisionFromTouches(
      lastTouches.map((t) => ({ id: t.id, updated_at: t.transaction_date })),
    );

    return {
      page_type: this.pageType,
      subject_id: month,
      slug: subject.slug,
      body_md: renderPage(`Monthly summary · ${month}`, {
        currentTruth,
        linkedEntities,
        recentActivity,
        openQuestions,
        timeline,
      }),
      source_revision: revision,
    };
  }
}

interface Totals {
  inflow: string | null;
  outflow: string | null;
  tx_count: number;
}
async function fetchTotals(deps: PageGenerationContext, start: Date, end: Date): Promise<Totals> {
  const { rows } = await deps.client.query<{
    inflow: string | null;
    outflow: string | null;
    tx_count: string;
  }>(
    `SELECT
       SUM(CASE WHEN direction = 'inflow' THEN amount ELSE 0 END)::text  AS inflow,
       SUM(CASE WHEN direction = 'outflow' THEN amount ELSE 0 END)::text AS outflow,
       count(*)::text                                                     AS tx_count
       FROM ledger_transactions
      WHERE transaction_date >= $1 AND transaction_date < $2
        AND status IN ('posted','cleared')`,
    [start, end],
  );
  const r = rows[0]!;
  return {
    inflow: r.inflow,
    outflow: r.outflow,
    tx_count: Number.parseInt(r.tx_count, 10),
  };
}

interface CpTotal {
  id: string;
  name: string;
  total: string;
  currency: string;
}
async function fetchTopCounterparties(
  deps: PageGenerationContext,
  start: Date,
  end: Date,
  direction: "inflow" | "outflow",
): Promise<CpTotal[]> {
  const { rows } = await deps.client.query<CpTotal>(
    `SELECT cp.id, cp.name, SUM(t.amount)::text AS total, t.currency
       FROM ledger_transactions t
       JOIN ledger_counterparties cp ON cp.id = t.counterparty_id
      WHERE t.direction = $1
        AND t.status IN ('posted','cleared')
        AND t.transaction_date >= $2 AND t.transaction_date < $3
      GROUP BY cp.id, cp.name, t.currency
      ORDER BY SUM(t.amount) DESC
      LIMIT 10`,
    [direction, start, end],
  );
  return rows;
}

interface OblRow {
  id: string;
  type: string;
  status: string;
  amount_due: string;
  currency: string;
  due_date: Date;
}
async function fetchObligationsDueIn(
  deps: PageGenerationContext,
  start: Date,
  end: Date,
): Promise<OblRow[]> {
  const { rows } = await deps.client.query<OblRow>(
    `SELECT id, type, status, amount_due, currency, due_date
       FROM ledger_obligations
      WHERE due_date >= $1 AND due_date < $2
      ORDER BY due_date ASC
      LIMIT 25`,
    [start, end],
  );
  return rows;
}

interface TouchRow {
  id: string;
  transaction_date: Date;
  amount: string;
  currency: string;
  direction: string;
  counterparty_id: string | null;
}
async function fetchLastTouches(
  deps: PageGenerationContext,
  start: Date,
  end: Date,
): Promise<TouchRow[]> {
  const { rows } = await deps.client.query<TouchRow>(
    `SELECT id, transaction_date, amount, currency, direction, counterparty_id
       FROM ledger_transactions
      WHERE transaction_date >= $1 AND transaction_date < $2
      ORDER BY transaction_date DESC
      LIMIT 15`,
    [start, end],
  );
  return rows;
}

function netDecimal(inflow: string | null, outflow: string | null): string {
  const i = Number.parseFloat(inflow ?? "0");
  const o = Number.parseFloat(outflow ?? "0");
  return (i - o).toFixed(2);
}
