/**
 * /invoices/{invoice_id} — page generator.
 */

import type { PageGenerationContext, PageGenerationOutput, PageGenerator } from "./types.js";
import { bullet, renderPage, revisionFromTouches } from "./sections.js";

export class InvoicePageGenerator implements PageGenerator {
  public readonly pageType = "invoice" as const;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (slugOrId === "invoices/all" || slugOrId === "/invoices/all") {
      return { subjectId: null, slug: "/invoices/all" };
    }
    if (slugOrId.startsWith("inv_")) {
      return { subjectId: slugOrId, slug: `/invoices/${slugOrId}` };
    }
    if (slugOrId.startsWith("/invoices/")) {
      const id = slugOrId.slice("/invoices/".length);
      return { subjectId: id, slug: slugOrId };
    }
    return null;
  }

  public async render(
    deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    const id = subject.subjectId;
    if (subject.slug === "/invoices/all") return renderInvoiceIndex(deps, subject.slug);
    if (id === null) throw new Error("InvoicePageGenerator requires a subject id");

    const inv = await fetchInvoice(deps, id);
    if (inv === null) throw new Error(`invoice ${id} not found`);

    // Sequential reads: one shared tenant-scoped client serializes queries on a
    // single connection anyway (pg@9 rejects concurrent client.query() calls).
    const counterparty = await fetchCounterparty(deps, inv.counterparty_id);
    const linkedTransactions = await fetchLinkedTransactions(deps, inv.linked_transaction_ids);
    const linkedDocuments = await fetchLinkedDocuments(deps, inv.linked_document_ids);

    const unpaid = parseFloat(inv.amount_due) - parseFloat(inv.amount_paid);
    const currentTruth =
      `**Invoice ${inv.invoice_number}**\n` +
      `Counterparty: ${counterparty === null ? `\`${inv.counterparty_id}\` (missing)` : `**${counterparty.name}** \`${counterparty.id}\``}\n` +
      `Amount due: ${inv.amount_due} ${inv.currency} · Paid: ${inv.amount_paid} ${inv.currency} · Outstanding: ${unpaid.toFixed(2)} ${inv.currency}\n` +
      `Status: \`${inv.status}\`\n` +
      `Issued: ${inv.issue_date.toISOString().slice(0, 10)}` +
      (inv.due_date !== null ? ` · Due: ${inv.due_date.toISOString().slice(0, 10)}` : "");

    const linkedEntities = bullet(
      [
        ...(counterparty !== null
          ? [`Counterparty: \`${counterparty.id}\` — ${counterparty.name}`]
          : []),
        ...linkedDocuments.map((d) => `Document: \`${d.id}\` — ${d.document_type}`),
      ],
      "_No linked entities._",
    );

    const recentActivity = bullet(
      linkedTransactions.map(
        (t) =>
          `${t.transaction_date.toISOString().slice(0, 10)} — ${t.direction} ${t.amount} ${t.currency} (\`${t.id}\`)`,
      ),
      "_No payments recorded against this invoice yet._",
    );

    const openQuestions =
      inv.status === "overdue"
        ? "**Overdue.** No payment has been matched to this invoice. Verify the counterparty has sent payment or escalate."
        : inv.status === "partial"
          ? `Partial payment received (${inv.amount_paid} of ${inv.amount_due} ${inv.currency}). Awaiting balance.`
          : inv.status === "sent"
            ? `Invoice sent; awaiting payment by ${inv.due_date?.toISOString().slice(0, 10) ?? "due date"}.`
            : "_None._";

    const riskNotes =
      inv.status === "overdue"
        ? "Overdue invoice — counterparty risk or payment dispute possible. Consider escalation."
        : inv.status === "disputed"
          ? "Invoice is disputed. Do not schedule payment execution until dispute is resolved."
          : "_No risk flags._";

    const timeline =
      inv.due_date !== null
        ? `Due: ${inv.due_date.toISOString().slice(0, 10)}`
        : "_No due date set._";

    const evidenceLinks = bullet(
      [
        ...inv.source_ids.slice(0, 5).map((s: string) => `\`${s}\` (raw artifact)`),
        ...inv.evidence_ids.slice(0, 5).map((e: string) => `\`${e}\` (evidence)`),
      ],
      "_No source evidence linked._",
    );

    const revision = revisionFromTouches([
      { id: inv.id, updated_at: inv.updated_at },
      ...linkedTransactions.map((t) => ({ id: t.id, updated_at: t.transaction_date })),
    ]);

    return {
      page_type: this.pageType,
      subject_id: id,
      slug: subject.slug,
      body_md: renderPage(`Invoice · ${inv.invoice_number}`, {
        currentTruth,
        linkedEntities,
        recentActivity,
        openQuestions,
        riskNotes,
        timeline,
        evidenceLinks,
      }),
      source_revision: revision,
    };
  }
}

async function renderInvoiceIndex(
  deps: PageGenerationContext,
  slug: string,
): Promise<PageGenerationOutput> {
  const summary = await fetchInvoiceSummary(deps);
  const invoices = await fetchRecentInvoices(deps);

  const currentTruth =
    `**Invoices**\n` +
    `Invoice count: ${summary.invoice_count}\n` +
    `Open amount: ${summary.open_amount} ${summary.currency ?? "USD"}\n` +
    `Paid amount: ${summary.paid_amount} ${summary.currency ?? "USD"}`;

  const linkedEntities = bullet(
    invoices.map(
      (inv) =>
        `\`${inv.id}\` ${inv.invoice_number} - ${inv.amount_due} ${inv.currency} [${inv.status}]`,
    ),
    "_No invoice rows are anchored in Ledger yet._",
  );

  const recentActivity = bullet(
    invoices.map(
      (inv) =>
        `${inv.updated_at.toISOString()} - ${inv.invoice_number} ${inv.amount_due} ${inv.currency} [${inv.status}]`,
    ),
    "_No invoice activity recorded._",
  );

  const openQuestions =
    summary.invoice_count === 0
      ? "No invoice-shaped Ledger rows exist yet. Uploaded receivables may currently be represented as obligations."
      : "_None._";

  const riskNotes =
    summary.overdue_count > 0
      ? `${summary.overdue_count} overdue invoice(s) require review.`
      : "_No invoice risk flags._";

  const revision = revisionFromTouches(
    invoices.map((inv) => ({ id: inv.id, updated_at: inv.updated_at })),
  );

  return {
    page_type: "invoice",
    subject_id: null,
    slug,
    body_md: renderPage("Invoices", {
      currentTruth,
      linkedEntities,
      recentActivity,
      openQuestions,
      riskNotes,
    }),
    source_revision: invoices.length > 0 ? revision : "invoices_all_empty",
  };
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  counterparty_id: string;
  amount_due: string;
  amount_paid: string;
  currency: string;
  issue_date: Date;
  due_date: Date | null;
  status: string;
  linked_document_ids: string[];
  linked_transaction_ids: string[];
  source_ids: string[];
  evidence_ids: string[];
  updated_at: Date;
}

interface InvoiceSummary {
  invoice_count: number;
  overdue_count: number;
  open_amount: string;
  paid_amount: string;
  currency: string | null;
}

async function fetchInvoiceSummary(deps: PageGenerationContext): Promise<InvoiceSummary> {
  const { rows } = await deps.client.query<{
    invoice_count: string;
    overdue_count: string;
    open_amount: string | null;
    paid_amount: string | null;
    currency: string | null;
  }>(
    `SELECT COUNT(*)::TEXT AS invoice_count,
            COUNT(*) FILTER (WHERE status = 'overdue')::TEXT AS overdue_count,
            COALESCE(SUM(amount_due - amount_paid), 0)::TEXT AS open_amount,
            COALESCE(SUM(amount_paid), 0)::TEXT AS paid_amount,
            MAX(currency) AS currency
       FROM ledger_invoices`,
  );
  const row = rows[0];
  if (row === undefined) {
    return {
      invoice_count: 0,
      overdue_count: 0,
      open_amount: "0",
      paid_amount: "0",
      currency: null,
    };
  }
  return {
    invoice_count: Number.parseInt(row.invoice_count, 10),
    overdue_count: Number.parseInt(row.overdue_count, 10),
    open_amount: row.open_amount ?? "0",
    paid_amount: row.paid_amount ?? "0",
    currency: row.currency,
  };
}

async function fetchRecentInvoices(deps: PageGenerationContext): Promise<InvoiceRow[]> {
  const { rows } = await deps.client.query<InvoiceRow>(
    `SELECT id, invoice_number, counterparty_id, amount_due::TEXT, amount_paid::TEXT,
            currency, issue_date, due_date, status,
            linked_document_ids, linked_transaction_ids,
            source_ids, evidence_ids, updated_at
       FROM ledger_invoices
      ORDER BY updated_at DESC
      LIMIT 25`,
  );
  return rows;
}

async function fetchInvoice(deps: PageGenerationContext, id: string): Promise<InvoiceRow | null> {
  const { rows } = await deps.client.query<InvoiceRow>(
    `SELECT id, invoice_number, counterparty_id, amount_due::TEXT, amount_paid::TEXT,
            currency, issue_date, due_date, status,
            linked_document_ids, linked_transaction_ids,
            source_ids, evidence_ids, updated_at
       FROM ledger_invoices WHERE id = $1 LIMIT 1`,
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
    `SELECT id, amount::TEXT, currency, direction, transaction_date
       FROM ledger_transactions WHERE id = ANY($1::TEXT[])
      ORDER BY transaction_date DESC`,
    [Array.from(ids)],
  );
  return rows;
}

interface DocRow {
  id: string;
  document_type: string;
}

async function fetchLinkedDocuments(
  deps: PageGenerationContext,
  ids: ReadonlyArray<string>,
): Promise<DocRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await deps.client.query<DocRow>(
    `SELECT id, document_type FROM ledger_documents WHERE id = ANY($1::TEXT[]) LIMIT 10`,
    [Array.from(ids)],
  );
  return rows;
}
