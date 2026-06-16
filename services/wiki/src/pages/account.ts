/**
 * /accounts/{account_id} — page generator.
 *
 * Renders the account's current balance, recent transactions, linked
 * counterparties, and any reconciliation gaps.
 */

import type { PageGenerationContext, PageGenerationOutput, PageGenerator } from "./types.js";
import { bullet, renderPage, revisionFromTouches } from "./sections.js";

export class AccountPageGenerator implements PageGenerator {
  public readonly pageType = "account" as const;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (slugOrId.startsWith("acct_")) return { subjectId: slugOrId, slug: `/accounts/${slugOrId}` };
    if (slugOrId.startsWith("/accounts/")) {
      const id = slugOrId.slice("/accounts/".length);
      return { subjectId: id, slug: slugOrId };
    }
    return null;
  }

  public async render(
    deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    const accountId = subject.subjectId;
    if (accountId === null) {
      throw new Error("AccountPageGenerator requires a subject id");
    }

    const acct = await fetchAccount(deps, accountId);
    if (acct === null) {
      throw new Error(`account ${accountId} not found`);
    }

    // Sequential reads: these share one tenant-scoped client, which serializes
    // queries on a single connection anyway (and pg@9 rejects concurrent
    // client.query() calls), so Promise.all here only triggers a deprecation.
    const latestBalance = await fetchLatestBalance(deps, accountId);
    const recentTx = await fetchRecentTransactions(deps, accountId, 10);
    const openObligations = await fetchOpenObligations(deps, accountId);
    const recentCps = await fetchRecentCounterparties(deps, accountId);
    const unreconciledCount = await countUnreconciled(deps, accountId);

    const currentTruth =
      `**${acct.name}** (${acct.account_type}) — ${acct.institution ?? "no institution"}\n` +
      `Currency: \`${acct.currency}\`\n` +
      `Status: \`${acct.status}\`\n` +
      `Current balance: ${formatBalance(acct.current_balance, acct.currency)}\n` +
      `Available balance: ${formatBalance(acct.available_balance, acct.currency)}\n` +
      (latestBalance !== null
        ? `Last balance snapshot: ${latestBalance.as_of.toISOString()}\n`
        : "");

    const linkedEntities = bullet(
      recentCps.map((cp) => `\`${cp.id}\` — ${cp.name} (${cp.type})`),
      "_No counterparties seen yet._",
    );

    const recentActivity = bullet(
      recentTx.map(
        (t) =>
          `${t.transaction_date.toISOString().slice(0, 10)} — ${t.direction} ` +
          `${t.amount} ${t.currency}` +
          ((t.description_normalized ?? t.description_raw)
            ? ` (${t.description_normalized ?? t.description_raw})`
            : ""),
      ),
      "_No recent transactions._",
    );

    const openQuestions =
      unreconciledCount > 0
        ? `${unreconciledCount} transactions remain unreconciled on this account. Run \`/ledger/reconcile\` to attempt automatic matching.`
        : "_No open reconciliation questions._";

    const riskNotes =
      acct.status !== "active"
        ? `**Status is \`${acct.status}\`** — most agent flows will reject this account in the §6 pre-execution gate.`
        : "_No risk flags._";

    const obligationLines = openObligations.map(
      (o) =>
        `- ${o.due_date.toISOString().slice(0, 10)} — ${o.type} (${o.status}) ` +
        `— ${o.amount_due} ${o.currency} → \`${o.id}\``,
    );
    const timeline =
      obligationLines.length === 0 ? "_No upcoming obligations._" : obligationLines.join("\n");

    const evidenceLinks = bullet(
      acct.source_ids.slice(0, 10).map((id: string) => `\`${id}\` (raw artifact)`),
      "_No raw source artifacts linked._",
    );

    const revision = revisionFromTouches([
      { id: acct.id, updated_at: acct.updated_at },
      ...recentTx.map((t) => ({ id: t.id, updated_at: t.transaction_date })),
      ...openObligations.map((o) => ({ id: o.id, updated_at: o.due_date })),
    ]);

    return {
      page_type: this.pageType,
      subject_id: accountId,
      slug: subject.slug,
      body_md: renderPage(`Account · ${acct.name}`, {
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

// ---------- Queries -------------------------------------------------------

interface AcctRow {
  id: string;
  name: string;
  account_type: string;
  institution: string | null;
  currency: string;
  current_balance: string | null;
  available_balance: string | null;
  status: string;
  source_ids: string[];
  updated_at: Date;
}

async function fetchAccount(deps: PageGenerationContext, id: string): Promise<AcctRow | null> {
  const { rows } = await deps.client.query<AcctRow>(
    `SELECT id, name, account_type, institution, currency,
            current_balance, available_balance, status,
            source_ids, updated_at
       FROM ledger_accounts WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function fetchLatestBalance(
  deps: PageGenerationContext,
  accountId: string,
): Promise<{ as_of: Date } | null> {
  const { rows } = await deps.client.query<{ as_of: Date }>(
    `SELECT as_of FROM ledger_balances WHERE account_id = $1 ORDER BY as_of DESC LIMIT 1`,
    [accountId],
  );
  return rows[0] ?? null;
}

interface TxRow {
  id: string;
  amount: string;
  currency: string;
  direction: string;
  transaction_date: Date;
  description_raw: string | null;
  description_normalized: string | null;
}
async function fetchRecentTransactions(
  deps: PageGenerationContext,
  accountId: string,
  limit: number,
): Promise<TxRow[]> {
  const { rows } = await deps.client.query<TxRow>(
    `SELECT id, amount, currency, direction, transaction_date,
            description_raw, description_normalized
       FROM ledger_transactions
      WHERE account_id = $1
      ORDER BY transaction_date DESC
      LIMIT $2`,
    [accountId, limit],
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
async function fetchOpenObligations(
  deps: PageGenerationContext,
  accountId: string,
): Promise<OblRow[]> {
  const { rows } = await deps.client.query<OblRow>(
    `SELECT o.id, o.type, o.status, o.amount_due, o.currency, o.due_date
       FROM ledger_obligations o
      WHERE o.status IN ('upcoming','due','overdue')
        AND EXISTS (
          SELECT 1 FROM ledger_transactions t
           WHERE t.account_id = $1
             AND t.counterparty_id = o.counterparty_id
        )
      ORDER BY o.due_date ASC
      LIMIT 5`,
    [accountId],
  );
  return rows;
}

interface CpRow {
  id: string;
  name: string;
  type: string;
}
async function fetchRecentCounterparties(
  deps: PageGenerationContext,
  accountId: string,
): Promise<CpRow[]> {
  const { rows } = await deps.client.query<CpRow>(
    `SELECT DISTINCT cp.id, cp.name, cp.type
       FROM ledger_counterparties cp
       JOIN ledger_transactions t ON t.counterparty_id = cp.id
      WHERE t.account_id = $1
      ORDER BY cp.name ASC
      LIMIT 10`,
    [accountId],
  );
  return rows;
}

async function countUnreconciled(deps: PageGenerationContext, accountId: string): Promise<number> {
  const { rows } = await deps.client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ledger_transactions
      WHERE account_id = $1
        AND (reconciliation_status IS NULL OR reconciliation_status = 'unreconciled')`,
    [accountId],
  );
  return Number.parseInt(rows[0]?.count ?? "0", 10);
}

function formatBalance(value: string | null, currency: string): string {
  if (value === null) return "_unknown_";
  return `\`${value} ${currency}\``;
}
