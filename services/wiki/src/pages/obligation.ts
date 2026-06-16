/**
 * /obligations/{obligation_id} — page generator.
 */

import type { PageGenerationContext, PageGenerationOutput, PageGenerator } from "./types.js";
import { bullet, renderPage, revisionFromTouches } from "./sections.js";

export class ObligationPageGenerator implements PageGenerator {
  public readonly pageType = "obligation" as const;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (slugOrId.startsWith("obl_"))
      return { subjectId: slugOrId, slug: `/obligations/${slugOrId}` };
    if (slugOrId.startsWith("/obligations/")) {
      const id = slugOrId.slice("/obligations/".length);
      return { subjectId: id, slug: slugOrId };
    }
    return null;
  }

  public async render(
    deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    const id = subject.subjectId;
    if (id === null) throw new Error("ObligationPageGenerator requires a subject id");

    const obl = await fetchObligation(deps, id);
    if (obl === null) throw new Error(`obligation ${id} not found`);
    // Sequential reads: one shared tenant-scoped client serializes queries on a
    // single connection anyway (pg@9 rejects concurrent client.query() calls).
    const counterparty = await fetchCounterparty(deps, obl.counterparty_id);
    const linkedTransactions = await fetchLinkedTransactions(deps, obl.linked_transaction_ids);
    const openIntents = await fetchOpenIntentsFor(deps, id);

    const currentTruth =
      `**${obl.type}** — ${obl.amount_due} ${obl.currency}\n` +
      `Status: \`${obl.status}\`\n` +
      `Due: ${obl.due_date.toISOString().slice(0, 10)}\n` +
      `Counterparty: ${counterparty === null ? `\`${obl.counterparty_id}\` (missing)` : `**${counterparty.name}** \`${counterparty.id}\``}\n`;

    const linkedEntities = bullet(
      [
        ...(counterparty !== null
          ? [`Counterparty: \`${counterparty.id}\` — ${counterparty.name}`]
          : []),
        ...openIntents.map(
          (pi) => `Open PaymentIntent: \`${pi.id}\` (${pi.status}, ${pi.amount} ${pi.currency})`,
        ),
      ],
      "_No linked entities._",
    );

    const recentActivity = bullet(
      linkedTransactions.map(
        (t) =>
          `${t.transaction_date.toISOString().slice(0, 10)} — ${t.direction} ${t.amount} ${t.currency} (\`${t.id}\`)`,
      ),
      "_No payments recorded against this obligation yet._",
    );

    const openQuestions =
      obl.status === "overdue"
        ? "**Overdue.** Reconciliation hasn't matched a payment to this obligation. Check the bank-feed for an outflow near the due date or capture a paper receipt."
        : obl.status === "upcoming" && linkedTransactions.length === 0
          ? "_Awaiting payment._"
          : "_None._";

    const riskNotes =
      obl.status === "overdue"
        ? "Late-payment risk: contact the counterparty or escalate to the payment-agent."
        : "_No risk flags._";

    const evidenceLinks = bullet(
      obl.source_ids.slice(0, 10).map((s: string) => `\`${s}\` (raw artifact)`),
      "_No source evidence linked._",
    );

    const revision = revisionFromTouches([
      { id: obl.id, updated_at: obl.updated_at },
      ...linkedTransactions.map((t) => ({ id: t.id, updated_at: t.transaction_date })),
    ]);

    return {
      page_type: this.pageType,
      subject_id: id,
      slug: subject.slug,
      body_md: renderPage(`Obligation · ${obl.type}`, {
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

interface OblRow {
  id: string;
  type: string;
  counterparty_id: string;
  amount_due: string;
  currency: string;
  due_date: Date;
  status: string;
  linked_transaction_ids: string[];
  source_ids: string[];
  updated_at: Date;
}
async function fetchObligation(deps: PageGenerationContext, id: string): Promise<OblRow | null> {
  const { rows } = await deps.client.query<OblRow>(
    `SELECT id, type, counterparty_id, amount_due, currency, due_date, status,
            linked_transaction_ids, source_ids, updated_at
       FROM ledger_obligations WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function fetchCounterparty(
  deps: PageGenerationContext,
  id: string,
): Promise<{ id: string; name: string } | null> {
  const { rows } = await deps.client.query<{ id: string; name: string }>(
    `SELECT id, name FROM ledger_counterparties WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

interface TxRow {
  id: string;
  amount: string;
  currency: string;
  direction: string;
  transaction_date: Date;
}
async function fetchLinkedTransactions(
  deps: PageGenerationContext,
  ids: ReadonlyArray<string>,
): Promise<TxRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await deps.client.query<TxRow>(
    `SELECT id, amount, currency, direction, transaction_date
       FROM ledger_transactions WHERE id = ANY ($1::TEXT[])
      ORDER BY transaction_date DESC`,
    [Array.from(ids)],
  );
  return rows;
}

interface PiRow {
  id: string;
  status: string;
  amount: string;
  currency: string;
}
async function fetchOpenIntentsFor(
  deps: PageGenerationContext,
  obligationId: string,
): Promise<PiRow[]> {
  const { rows } = await deps.client.query<PiRow>(
    `SELECT id, status, amount, currency
       FROM ledger_payment_intents
      WHERE obligation_id = $1 AND status NOT IN ('executed','rejected','cancelled','failed')
      ORDER BY created_at DESC
      LIMIT 5`,
    [obligationId],
  );
  return rows;
}
