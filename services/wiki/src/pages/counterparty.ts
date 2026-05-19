/**
 * /counterparties/{counterparty_id} — page generator.
 */

import type { PageGenerationContext, PageGenerationOutput, PageGenerator } from "./types.js";
import { bullet, renderPage, revisionFromTouches } from "./sections.js";

export class CounterpartyPageGenerator implements PageGenerator {
  public readonly pageType = "counterparty" as const;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (slugOrId.startsWith("cp_"))
      return { subjectId: slugOrId, slug: `/counterparties/${slugOrId}` };
    if (slugOrId.startsWith("/counterparties/")) {
      const id = slugOrId.slice("/counterparties/".length);
      return { subjectId: id, slug: slugOrId };
    }
    return null;
  }

  public async render(
    deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    const id = subject.subjectId;
    if (id === null) throw new Error("CounterpartyPageGenerator requires a subject id");

    const cp = await fetchCounterparty(deps, id);
    if (cp === null) throw new Error(`counterparty ${id} not found`);
    const [openObligations, recentTx] = await Promise.all([
      fetchOpenObligations(deps, id),
      fetchRecentTransactions(deps, id),
    ]);

    const currentTruth =
      `**${cp.name}** (${cp.type})\n` +
      `Verified: \`${cp.verified_status ?? "unverified"}\`\n` +
      `Risk: \`${cp.risk_level ?? "unknown"}\`\n` +
      (cp.aliases.length > 0 ? `Aliases: ${cp.aliases.map((a) => `\`${a}\``).join(", ")}\n` : "");

    const linkedEntities = bullet(
      [
        ...openObligations.map(
          (o) =>
            `\`${o.id}\` — ${o.type} due ${o.due_date.toISOString().slice(0, 10)} (${o.amount_due} ${o.currency})`,
        ),
      ],
      "_No open obligations._",
    );

    const recentActivity = bullet(
      recentTx.map(
        (t) =>
          `${t.transaction_date.toISOString().slice(0, 10)} · ${t.direction} ${t.amount} ${t.currency} via account ${t.account_id}`,
      ),
      "_No recent transactions._",
    );

    const riskNotes =
      cp.risk_level === "sanctioned"
        ? "**Sanctioned counterparty.** All payments to this counterparty will be rejected by the §6 pre-execution gate (check 5)."
        : cp.risk_level === "high"
          ? "Risk level is `high`. Policies that demand counterparty.verified will block payments above their threshold (gate check 6)."
          : cp.verified_status === "unverified"
            ? "Verified status is `unverified`. Payments above the policy threshold will fail check 6."
            : "_No active risk flags._";

    const openQuestions =
      cp.verified_status === "unverified" || cp.verified_status === null
        ? "Counterparty is unverified. Capture document evidence (e.g. W-9, vendor packet) and run `/wiki/annotate` to set `verified_status`."
        : "_None._";

    const evidenceLinks = bullet(
      cp.source_ids.slice(0, 10).map((s: string) => `\`${s}\` (raw artifact)`),
      "_No source evidence linked._",
    );

    const revision = revisionFromTouches([
      { id: cp.id, updated_at: cp.updated_at },
      ...recentTx.map((t) => ({ id: t.id, updated_at: t.transaction_date })),
    ]);

    return {
      page_type: this.pageType,
      subject_id: id,
      slug: subject.slug,
      body_md: renderPage(`Counterparty · ${cp.name}`, {
        currentTruth,
        linkedEntities,
        recentActivity,
        openQuestions,
        riskNotes,
        evidenceLinks,
      }),
      source_revision: revision,
    };
  }
}

interface CpRow {
  id: string;
  name: string;
  type: string;
  risk_level: string | null;
  verified_status: string | null;
  aliases: string[];
  source_ids: string[];
  updated_at: Date;
}

async function fetchCounterparty(deps: PageGenerationContext, id: string): Promise<CpRow | null> {
  const { rows } = await deps.client.query<CpRow>(
    `SELECT id, name, type, risk_level, verified_status,
            aliases, source_ids, updated_at
       FROM ledger_counterparties WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

interface OblRow {
  id: string;
  type: string;
  status: string;
  amount_due: string;
  currency: string;
  due_date: Date;
}
async function fetchOpenObligations(deps: PageGenerationContext, id: string): Promise<OblRow[]> {
  const { rows } = await deps.client.query<OblRow>(
    `SELECT id, type, status, amount_due, currency, due_date
       FROM ledger_obligations
      WHERE counterparty_id = $1 AND status IN ('upcoming','due','overdue')
      ORDER BY due_date ASC
      LIMIT 10`,
    [id],
  );
  return rows;
}

interface TxRow {
  id: string;
  account_id: string;
  amount: string;
  currency: string;
  direction: string;
  transaction_date: Date;
}
async function fetchRecentTransactions(deps: PageGenerationContext, id: string): Promise<TxRow[]> {
  const { rows } = await deps.client.query<TxRow>(
    `SELECT id, account_id, amount, currency, direction, transaction_date
       FROM ledger_transactions
      WHERE counterparty_id = $1
      ORDER BY transaction_date DESC
      LIMIT 10`,
    [id],
  );
  return rows;
}
