import { randomUUID } from "node:crypto";
import {
  brainError,
  withTenantScope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import {
  DecisionAuditLogService,
  getProposal as defaultGetProposal,
  insertProposalSnapshot,
  listProposals as defaultListProposals,
  type DecisionAuditLogEntry,
  type ProposalReadItem,
} from "@brain/execution";
import type { AskResult } from "@brain/wiki";
import type {
  RoboAnswer,
  RoboAskFromContextRequest,
  RoboAskFromContextResponse,
  RoboBriefHighlight,
  RoboBriefRequest,
  RoboBriefResponse,
  RoboBriefSignal,
  RoboBriefNextPrompt,
  RoboContextSource,
  RoboOvernightResponse,
  RoboServiceDeps,
} from "./types.js";

interface BriefCacheRow {
  response: RoboBriefResponse;
}

interface AmountRow {
  currency: string;
  value_cents: string | number | null;
}

interface SparklineRow {
  day: Date | string;
  currency: string;
  value_cents: string | number | null;
}

export class RoboService {
  private readonly getProposal: NonNullable<RoboServiceDeps["getProposal"]>;
  private readonly listProposals: NonNullable<RoboServiceDeps["listProposals"]>;
  private readonly insertSnapshot: NonNullable<RoboServiceDeps["insertSnapshot"]>;
  private readonly auditLog: NonNullable<RoboServiceDeps["auditLog"]>;
  private readonly now: () => Date;
  private readonly threadIdFactory: () => string;
  private readonly messageIdFactory: () => string;

  public constructor(private readonly deps: RoboServiceDeps) {
    this.getProposal = deps.getProposal ?? defaultGetProposal;
    this.listProposals = deps.listProposals ?? defaultListProposals;
    this.insertSnapshot = deps.insertSnapshot ?? insertProposalSnapshot;
    this.auditLog = deps.auditLog ?? new DecisionAuditLogService(deps.pool);
    this.now = deps.now ?? (() => new Date());
    this.threadIdFactory = deps.threadIdFactory ?? randomUUID;
    this.messageIdFactory = deps.messageIdFactory ?? randomUUID;
  }

  public async getBrief(ctx: ServiceCallContext, tenantId: string, date: string) {
    this.assertTenant(ctx, tenantId);
    const briefDate = parseBriefDate(date);
    const cached = await this.readCachedBrief(ctx, briefDate);
    if (cached === null) {
      throw brainError("robo_brief_not_found", "brief does not exist", { statusOverride: 404 });
    }
    return cached;
  }

  public async createBrief(ctx: ServiceCallContext, input: RoboBriefRequest) {
    this.assertTenant(ctx, input.tenant_id);
    const briefDate = input.as_of === undefined ? isoDay(this.now()) : parseBriefDate(input.as_of);
    const cached = await this.readCachedBrief(ctx, briefDate);
    if (cached !== null) return cached;

    const compiled = await this.compileBrief(ctx, briefDate);
    return withTenantScope(this.deps.pool, ctx.tenantId, async (client) => {
      const inserted = await client.query<BriefCacheRow>(
        `INSERT INTO brief_cache (tenant_id, brief_date, response, prepared_at)
         VALUES (current_setting('app.tenant_id', true), $1::date, $2::jsonb, $3::timestamptz)
         ON CONFLICT (tenant_id, brief_date) DO NOTHING
         RETURNING response`,
        [briefDate, JSON.stringify(compiled), compiled.prepared_at],
      );
      const row = inserted.rows[0];
      if (row !== undefined) return normalizeBrief(row.response);
      const replay = await client.query<BriefCacheRow>(
        `SELECT response
           FROM brief_cache
          WHERE tenant_id = current_setting('app.tenant_id', true)
            AND brief_date = $1::date`,
        [briefDate],
      );
      return normalizeBrief(replay.rows[0]!.response);
    });
  }

  public async getOvernight(ctx: ServiceCallContext): Promise<RoboOvernightResponse> {
    const now = this.now();
    const start = await this.overnightWindowStart(ctx, now);
    const result = await this.auditLog.list(ctx, {
      from: start.toISOString(),
      to: now.toISOString(),
      limit: 50,
    });
    const ranked = result.entries
      .map((entry) => ({ entry, importance: actionImportance(entry) }))
      .sort((a, b) => {
        if (a.importance !== b.importance) return b.importance - a.importance;
        return Date.parse(b.entry.occurred_at) - Date.parse(a.entry.occurred_at);
      })
      .slice(0, 8);
    return {
      window: {
        start: start.toISOString(),
        end: now.toISOString(),
      },
      action_count: result.entries.length,
      actions: ranked.map(({ entry }) => ({
        agent: displayAgent(entry.agent),
        summary: overnightSummary(entry),
        related_proposal_ids: entry.proposal_id.length > 0 ? [entry.proposal_id] : [],
        occurred_at: entry.occurred_at,
      })),
    };
  }

  public async askFromContext(
    ctx: ServiceCallContext,
    input: RoboAskFromContextRequest,
  ): Promise<RoboAskFromContextResponse> {
    this.assertTenant(ctx, input.tenant_id);
    assertContextSource(input.source);
    if (
      typeof input.prompt !== "string" ||
      input.prompt.length === 0 ||
      input.prompt.length > 2000
    ) {
      throw brainError("request_body_invalid", "prompt is required");
    }

    const proposal = await this.getProposal(this.deps.pool, ctx, input.source.proposal_id);
    if (proposal === null) {
      throw brainError("execution_proposal_not_found", "no such proposal", { statusOverride: 404 });
    }

    const threadId = this.threadIdFactory();
    const title = roboThreadTitle(input.source, input.prompt);
    const snapshotPayload = {
      kind: "robo_context_proposal_snapshot",
      source: input.source,
      proposal,
    };
    const created = await withTenantScope(this.deps.pool, ctx.tenantId, async (client) => {
      const snapshot = await this.insertSnapshot(client, ctx, snapshotPayload);
      await client.query(
        `INSERT INTO robo_threads (
           id, tenant_id, title, source, payload_snapshot_id, created_by
         )
         VALUES ($1, current_setting('app.tenant_id', true), $2, $3::jsonb, $4, $5)`,
        [threadId, title, JSON.stringify(input.source), snapshot.id, ctx.actor],
      );
      await client.query(
        `INSERT INTO robo_messages (
           id, tenant_id, thread_id, role, content, context
         )
         VALUES ($1, current_setting('app.tenant_id', true), $2, 'user', $3, $4::jsonb)`,
        [
          this.messageIdFactory(),
          threadId,
          input.prompt,
          JSON.stringify({ source: input.source, payload_snapshot_id: snapshot.id }),
        ],
      );
      return { snapshotId: snapshot.id };
    });

    const askResult = await withTenantScope(this.deps.pool, ctx.tenantId, async (client) => {
      const result = await this.deps.askWiki({
        deps: {
          ...this.deps.wikiDeps,
          client,
          requestContext: ctx,
          policyContext: ctx,
        },
        options: {
          question: contextualPrompt(input.prompt, input.source, proposal),
          asOf: null,
          maxEvidenceDepth: 5,
          tenantId: ctx.tenantId,
          model: this.deps.questionModel,
        },
      });
      if (result.deterministicIntentId !== undefined) {
        await this.deps.recordDeterministicIntentUsage(client, result.deterministicIntentId);
      }
      return result;
    });
    const answer = toRoboAnswer(askResult);

    await withTenantScope(this.deps.pool, ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO robo_messages (
           id, tenant_id, thread_id, role, content, answer, context
         )
         VALUES ($1, current_setting('app.tenant_id', true), $2, 'assistant', $3, $4::jsonb, $5::jsonb)`,
        [
          this.messageIdFactory(),
          threadId,
          answer.text,
          JSON.stringify(answer),
          JSON.stringify({ source: input.source, payload_snapshot_id: created.snapshotId }),
        ],
      );
    });

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "wiki",
      eventType: "assistant_activity",
      severity: "info",
      actor: ctx.actor,
      action: "robo.thread.opened_from_context",
      inputs: {
        source: input.source,
        prompt_length: input.prompt.length,
        open_thread: input.open_thread ?? true,
      },
      outputs: {
        thread_id: threadId,
        payload_snapshot_id: created.snapshotId,
        answered: askResult.answered,
      },
    });

    return { thread_id: threadId, first_response: answer };
  }

  private async readCachedBrief(
    ctx: ServiceCallContext,
    briefDate: string,
  ): Promise<RoboBriefResponse | null> {
    return withTenantScope(this.deps.pool, ctx.tenantId, async (client) => {
      const { rows } = await client.query<BriefCacheRow>(
        `SELECT response
           FROM brief_cache
          WHERE tenant_id = current_setting('app.tenant_id', true)
            AND brief_date = $1::date`,
        [briefDate],
      );
      const row = rows[0];
      return row === undefined ? null : normalizeBrief(row.response);
    });
  }

  private async compileBrief(
    ctx: ServiceCallContext,
    briefDate: string,
  ): Promise<RoboBriefResponse> {
    const proposalsResult = await this.listProposals(this.deps.pool, ctx, {
      status: "pending",
      limit: 50,
    });
    const proposals = proposalsResult.proposals;
    const [signals, overnight] = await Promise.all([
      withTenantScope(this.deps.pool, ctx.tenantId, (client) =>
        this.readBriefSignals(client, briefDate, proposals),
      ),
      this.getOvernight(ctx),
    ]);
    const highlights = urgentHighlights(proposals);
    const preparedAt = this.now().toISOString();
    return {
      tenant_id: ctx.tenantId,
      date: briefDate,
      prepared_at: preparedAt,
      signals,
      body_markdown: briefMarkdown(signals, highlights, overnight.action_count),
      highlights,
      next_prompts: nextPrompts(highlights, signals),
    };
  }

  private async readBriefSignals(
    client: TenantScopedClient,
    briefDate: string,
    proposals: ProposalReadItem[],
  ): Promise<RoboBriefSignal[]> {
    const [currentRows, priorRows, sparklineRows, netRows, priorNetRows] = await Promise.all([
      client.query<AmountRow>(
        `WITH latest AS (
           SELECT DISTINCT ON (account_id) account_id, currency, current_balance
             FROM ledger_balances
            WHERE as_of < ($1::date + interval '1 day')
            ORDER BY account_id, as_of DESC
         )
         SELECT currency, round(sum(current_balance) * 100)::bigint AS value_cents
           FROM latest
          GROUP BY currency
          ORDER BY currency`,
        [briefDate],
      ),
      client.query<AmountRow>(
        `WITH latest AS (
           SELECT DISTINCT ON (account_id) account_id, currency, current_balance
             FROM ledger_balances
            WHERE as_of < ($1::date - interval '6 day')
            ORDER BY account_id, as_of DESC
         )
         SELECT currency, round(sum(current_balance) * 100)::bigint AS value_cents
           FROM latest
          GROUP BY currency
          ORDER BY currency`,
        [briefDate],
      ),
      client.query<SparklineRow>(
        `WITH ranked AS (
           SELECT date_trunc('day', as_of)::date AS day,
                  account_id,
                  currency,
                  current_balance,
                  row_number() OVER (
                    PARTITION BY account_id, date_trunc('day', as_of)::date
                    ORDER BY as_of DESC
                  ) AS rn
             FROM ledger_balances
            WHERE as_of >= ($1::date - interval '6 day')
              AND as_of < ($1::date + interval '1 day')
         )
         SELECT day, currency, round(sum(current_balance) * 100)::bigint AS value_cents
           FROM ranked
          WHERE rn = 1
          GROUP BY day, currency
          ORDER BY day`,
        [briefDate],
      ),
      client.query<AmountRow>(
        `SELECT currency,
                round(sum(
                  CASE
                    WHEN direction = 'inflow' THEN amount
                    WHEN direction = 'outflow' THEN -amount
                    ELSE 0
                  END
                ) * 100)::bigint AS value_cents
           FROM ledger_transactions
          WHERE transaction_date >= ($1::date - interval '29 day')
            AND transaction_date < ($1::date + interval '1 day')
            AND status IN ('posted', 'cleared')
          GROUP BY currency
          ORDER BY currency`,
        [briefDate],
      ),
      client.query<AmountRow>(
        `SELECT currency,
                round(sum(
                  CASE
                    WHEN direction = 'inflow' THEN amount
                    WHEN direction = 'outflow' THEN -amount
                    ELSE 0
                  END
                ) * 100)::bigint AS value_cents
           FROM ledger_transactions
          WHERE transaction_date >= ($1::date - interval '59 day')
            AND transaction_date < ($1::date - interval '29 day')
            AND status IN ('posted', 'cleared')
          GROUP BY currency
          ORDER BY currency`,
        [briefDate],
      ),
    ]);

    const currency = preferredCurrency(currentRows.rows);
    const current = rowForCurrency(currentRows.rows, currency);
    const prior = rowForCurrency(priorRows.rows, currency);
    const net = rowForCurrency(netRows.rows, currency);
    const priorNet = rowForCurrency(priorNetRows.rows, currency);
    const signals: RoboBriefSignal[] = [];
    if (current !== undefined) {
      signals.push({
        key: "cash_on_hand",
        value_cents: cents(current.value_cents),
        currency,
        ...(prior !== undefined
          ? { delta_cents_7d: cents(current.value_cents) - cents(prior.value_cents) }
          : {}),
        sparkline: sparklineRows.rows
          .filter((row) => row.currency === currency)
          .map((row) => ({ date: isoDay(row.day), value_cents: cents(row.value_cents) })),
      });
    }
    if (net !== undefined) {
      const netCents = cents(net.value_cents);
      const priorCents = priorNet === undefined ? null : cents(priorNet.value_cents);
      signals.push({
        key: "net_30_day",
        value_cents: netCents,
        currency,
        ...(priorCents !== null && priorCents !== 0
          ? {
              delta_pct: Number(
                (((netCents - priorCents) / Math.abs(priorCents)) * 100).toFixed(2),
              ),
            }
          : {}),
      });
    }
    const runway = runwaySignal(proposals);
    if (runway !== null) signals.push(runway);
    return signals;
  }

  private async overnightWindowStart(ctx: ServiceCallContext, now: Date): Promise<Date> {
    const fallback = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const lastLogin = await withTenantScope(this.deps.pool, ctx.tenantId, async (client) => {
      const { rows } = await client.query<{ created_at: Date | string }>(
        `SELECT created_at
           FROM audit_events
          WHERE tenant_id = current_setting('app.tenant_id', true)
            AND action = 'auth.login'
            AND actor = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [ctx.actor],
      );
      return rows[0]?.created_at;
    });
    if (lastLogin === undefined) return fallback;
    const parsed = lastLogin instanceof Date ? lastLogin : new Date(lastLogin);
    if (Number.isNaN(parsed.getTime())) return fallback;
    return parsed.getTime() < fallback.getTime() ? fallback : parsed;
  }

  private assertTenant(ctx: ServiceCallContext, tenantId: string): void {
    if (ctx.tenantId !== tenantId) {
      throw brainError("auth_tenant_mismatch", "tenant id does not match authenticated tenant");
    }
  }
}

export function toRoboAnswer(result: AskResult): RoboAnswer {
  return {
    text: result.answer,
    data_cards: [],
    charts: [],
    follow_ups: [],
    refs: result.evidence.map((item) => ({
      kind:
        item.entityType === "invoice"
          ? "invoice"
          : item.entityType === "proposal"
            ? "proposal"
            : "record",
      id: item.entityId,
      display_name: item.entityId,
    })),
  };
}

export function roboThreadTitle(source: RoboContextSource, prompt: string): string {
  const rail = titleCase(source.rail.replace(/[_-]+/g, " "));
  if (rail.length > 0) return `${rail} from ${titleCase(source.agent.replace(/[_-]+/g, " "))}`;
  const words = prompt.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 0 ? words : "Robo context thread";
}

function contextualPrompt(
  prompt: string,
  source: RoboContextSource,
  proposal: ProposalReadItem,
): string {
  return [
    prompt,
    "",
    "Use this frozen proposal context when it is relevant to the answer.",
    `Source agent: ${source.agent}`,
    `Source rail: ${source.rail}`,
    `Proposal id: ${proposal.id}`,
    `Proposal type: ${proposal.type}`,
    `Proposal status: ${proposal.status}`,
    `Proposal details: ${JSON.stringify(proposal.details)}`,
  ].join("\n");
}

function normalizeBrief(value: RoboBriefResponse): RoboBriefResponse {
  return value;
}

function parseBriefDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw brainError("request_params_invalid", "date must be YYYY-MM-DD or an ISO timestamp");
  }
  return isoDay(parsed);
}

function isoDay(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
}

function cents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function preferredCurrency(rows: AmountRow[]): string {
  if (rows.some((row) => row.currency === "USD")) return "USD";
  return rows[0]?.currency ?? "USD";
}

function rowForCurrency(rows: AmountRow[], currency: string): AmountRow | undefined {
  return rows.find((row) => row.currency === currency);
}

function urgentHighlights(proposals: ProposalReadItem[]): RoboBriefHighlight[] {
  return proposals
    .filter((proposal) => proposal.status === "pending")
    .map((proposal) => {
      const urgency: RoboBriefHighlight["urgency"] =
        proposal.risk_band === "high"
          ? "urgent"
          : proposal.risk_band === "elevated"
            ? "attention"
            : "info";
      const amount = amountCents(proposal.details);
      const detailCurrency = currency(proposal.details);
      return {
        proposal_id: proposal.id,
        agent: proposal.agent?.display_name ?? proposal.agent?.kind ?? proposal.type,
        title: proposal.presentation.headline || proposal.narrative || titleCase(proposal.type),
        ...(amount !== undefined ? { amount_cents: amount } : {}),
        ...(detailCurrency !== undefined ? { currency: detailCurrency } : {}),
        urgency,
      };
    })
    .filter((highlight) => highlight.urgency !== "info")
    .slice(0, 5);
}

function amountCents(details: Record<string, unknown>): number | undefined {
  for (const key of ["amount_cents", "value_cents", "unmatched_total_cents"]) {
    const value = details[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
    if (typeof value === "string" && Number.isFinite(Number(value)))
      return Math.round(Number(value));
  }
  for (const key of ["amount", "amount_due", "unmatched_total", "matched_total"]) {
    const value = details[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100);
    if (typeof value === "string" && Number.isFinite(Number(value))) {
      return Math.round(Number(value) * 100);
    }
  }
  return undefined;
}

function currency(details: Record<string, unknown>): string | undefined {
  const value = details["currency"];
  return typeof value === "string" ? value : undefined;
}

function runwaySignal(proposals: ProposalReadItem[]): RoboBriefSignal | null {
  const proposal = proposals.find((item) => item.type === "cash_forecast");
  if (proposal === undefined) return null;
  const details = proposal.details;
  const firstPoint = proposal.runway_projection?.[0] as Record<string, unknown> | undefined;
  const valueMonths = numberish(
    firstPoint?.["projected_runway_months"] ?? details["runway_months"],
  );
  const burn = numberish(details["at_burn_cents"] ?? details["monthly_burn_cents"]);
  const extendsTo = numberish(details["extends_to_months_if_forecast"]);
  if (valueMonths === undefined && burn === undefined && extendsTo === undefined) return null;
  return {
    key: "runway_months",
    ...(valueMonths !== undefined ? { value_months: valueMonths } : {}),
    ...(burn !== undefined ? { at_burn_cents: Math.round(burn) } : {}),
    ...(extendsTo !== undefined ? { extends_to_months_if_forecast: extendsTo } : {}),
  };
}

function numberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function actionImportance(entry: DecisionAuditLogEntry): number {
  if (entry.event_action === "decision.auto_executed") return 4;
  if (entry.event_action === "decision.executed") return 3;
  if (entry.event_action === "decision.escalated") return 2;
  return 1;
}

function displayAgent(agent: string): string {
  const labels: Record<string, string> = {
    reconciliation: "Reconciliation",
    aml_compliance: "AML",
    collections: "Collections",
    fraud_anomaly: "Fraud",
    payable_approval: "Payables",
    payment: "Payables",
    cash_forecast: "Cash",
    treasury: "Treasury",
    vendor_risk: "Vendor Risk",
    dispute: "Dispute",
    revenue_intel: "Revenue Intel",
    subscription_management: "Subscription",
    invoice_integrity: "Invoice Integrity",
  };
  return labels[agent] ?? titleCase(agent.replace(/[_-]+/g, " "));
}

export function composeOvernightSummary(entry: DecisionAuditLogEntry): string {
  switch (entry.agent) {
    case "reconciliation":
      return reconciliationSummary(entry);
    case "aml_compliance":
      return amlSummary(entry);
    case "collections":
      return collectionsSummary(entry);
    case "fraud_anomaly":
      return fraudSummary(entry);
    case "payable_approval":
    case "payment":
      return payablesSummary(entry);
    case "cash_forecast":
      return cashSummary(entry);
    case "treasury":
      return treasurySummary(entry);
    case "vendor_risk":
      return vendorRiskSummary(entry);
    case "dispute":
      return disputeSummary(entry);
    case "revenue_intel":
      return revenueIntelSummary(entry);
    case "subscription_management":
      return subscriptionSummary(entry);
    case "invoice_integrity":
      return invoiceIntegritySummary(entry);
    default:
      return fallbackOvernightSummary(entry);
  }
}

function overnightSummary(entry: DecisionAuditLogEntry): string {
  return composeOvernightSummary(entry);
}

function reconciliationSummary(entry: DecisionAuditLogEntry): string {
  const matched = numberField(entry, ["matched_count"], ["close_aggregate", "matched_count"]);
  const exceptions = numberField(
    entry,
    ["exception_count"],
    ["unmatched_count"],
    ["close_aggregate", "unmatched_count"],
  );
  const period = stringField(entry, ["period"], ["close_aggregate", "period"]) ?? "latest";
  if (matched !== undefined) {
    const main = `Matched ${formatCount(matched)} ${period} bank items to invoices and bills`;
    return exceptions === undefined
      ? main
      : `${main} · ${formatCount(exceptions)} exceptions queued`;
  }
  if (exceptions !== undefined)
    return `Queued ${formatCount(exceptions)} reconciliation exceptions`;
  return "Refreshed reconciliation results";
}

function amlSummary(entry: DecisionAuditLogEntry): string {
  const vendor = stringField(entry, ["vendor"], ["beneficiary"], ["beneficiary_name"]);
  const checks = numberField(entry, ["checks_passed"]);
  const docs = numberField(entry, ["docs_needed"], ["documents_needed"]);
  if (vendor !== undefined && docs === 0)
    return `Cleared all checks on the ${vendor} wire, released`;
  if (vendor !== undefined && checks !== undefined) {
    const main = `Cleared ${formatCount(checks)} on the ${vendor} wire`;
    return docs === undefined ? main : `${main} · ${formatCount(docs)} still needed`;
  }
  if (vendor !== undefined) return `Reviewed AML checks on the ${vendor} wire`;
  return "Reviewed AML checks on a wire";
}

function collectionsSummary(entry: DecisionAuditLogEntry): string {
  const notice = stringField(entry, ["notice_type"]);
  const customer = stringField(entry, ["customer"], ["customer_name"]);
  if (notice !== undefined && customer !== undefined) {
    return `Drafted ${notice} notice to ${customer} · ready for your review`;
  }
  if (customer !== undefined) return `Drafted collections notice to ${customer}`;
  return "Drafted collections notice";
}

function fraudSummary(entry: DecisionAuditLogEntry): string {
  const amount = amountField(entry, ["amount"], ["amount_cents"]);
  const cardLast4 = stringField(entry, ["card_last4"], ["card", "last4"]);
  const reason = stringField(entry, ["reason_hint"], ["reason"]);
  const charge = amount === undefined ? "charge" : `${amount} charge`;
  const card = cardLast4 === undefined ? "card" : `${cardLast4} card`;
  const main = `Flagged unusual ${charge} on the ${card}`;
  return reason === undefined ? main : `${main} · ${reason}`;
}

function payablesSummary(entry: DecisionAuditLogEntry): string {
  const count = numberField(entry, ["count"], ["bill_count"]);
  const total = amountField(entry, ["total_amount"], ["total_amount_cents"]);
  if (count !== undefined && total !== undefined) {
    return `Auto-paid ${formatCount(count)} SaaS bills under threshold · ${total} total`;
  }
  if (count !== undefined) return `Auto-paid ${formatCount(count)} SaaS bills under threshold`;
  return "Processed SaaS bills under threshold";
}

function cashSummary(entry: DecisionAuditLogEntry): string {
  const months = numberField(entry, ["months"], ["runway_months"], ["projected_runway_months"]);
  const change =
    stringField(entry, ["change_word"]) ??
    runwayChangeWord(
      numberField(entry, ["runway_before_months"]),
      numberField(entry, ["runway_after_months"]),
    );
  if (months !== undefined && change !== undefined) {
    return `Refreshed cash forecast · runway ${change} at ${formatCount(months)} months`;
  }
  if (months !== undefined)
    return `Refreshed cash forecast · runway at ${formatCount(months)} months`;
  return "Refreshed cash forecast";
}

function treasurySummary(entry: DecisionAuditLogEntry): string {
  const amount = amountField(entry, ["amount"], ["swept_amount"], ["amount_cents"]);
  const apy = stringField(entry, ["apy"], ["yield_apy"]);
  if (amount !== undefined && apy !== undefined)
    return `Swept ${amount} to reserve · earning at ${apy}`;
  if (amount !== undefined) return `Swept ${amount} to reserve`;
  return "Reviewed reserve sweep";
}

function vendorRiskSummary(entry: DecisionAuditLogEntry): string {
  const vendor = stringField(entry, ["vendor"], ["vendor_name"], ["beneficiary"]);
  if (vendor !== undefined)
    return `Held ${vendor} wire pending routing verification · flagged for review`;
  return "Held wire pending routing verification";
}

function disputeSummary(entry: DecisionAuditLogEntry): string {
  const amount = amountField(entry, ["amount"], ["amount_cents"]);
  const date = stringField(entry, ["date"], ["response_expected"], ["expected_response_date"]);
  const main =
    amount === undefined
      ? "Filed dispute evidence for charge"
      : `Filed dispute evidence for ${amount} charge`;
  return date === undefined ? main : `${main} · Visa response expected ${date}`;
}

function revenueIntelSummary(entry: DecisionAuditLogEntry): string {
  const customer = stringField(
    entry,
    ["top_customer"],
    ["top_customer_name"],
    ["concentration", "breakdown", 0, "name"],
  );
  const pct = percentField(
    entry,
    ["pct"],
    ["top_customer_pct"],
    ["concentration", "top_customer_pct"],
  );
  const period = stringField(entry, ["period"], ["pipeline_coverage", "quarter"]) ?? "current";
  if (customer !== undefined && pct !== undefined) {
    return `Refreshed concentration for ${customer} · now ${pct} of ${period} revenue`;
  }
  if (customer !== undefined) return `Refreshed concentration for ${customer}`;
  return "Refreshed revenue concentration";
}

function subscriptionSummary(entry: DecisionAuditLogEntry): string {
  const vendor = stringField(entry, ["vendor"], ["vendor_name"], ["subscription_vendor"]);
  const pct = percentField(entry, ["price_delta_pct"]);
  const days = numberField(entry, ["days"], ["days_until_renewal"], ["renewal_in_days"]);
  if (vendor !== undefined && pct !== undefined && days !== undefined) {
    return `Flagged ${vendor} renewal · ${pct} increase in ${formatCount(days)} days`;
  }
  if (vendor !== undefined) return `Flagged ${vendor} renewal`;
  return "Flagged subscription renewal";
}

function invoiceIntegritySummary(entry: DecisionAuditLogEntry): string {
  const vendor = stringField(entry, ["vendor"], ["flagged_invoice", "vendor"]);
  const pct = percentField(entry, ["match_pct"], ["match_confidence", "pct"]);
  const prior = stringField(entry, ["prior_invoice"], ["suspected_original", "id"]);
  if (vendor !== undefined && pct !== undefined && prior !== undefined) {
    return `Flagged possible duplicate from ${vendor} · ${pct} match to ${prior}`;
  }
  if (vendor !== undefined) return `Flagged possible duplicate from ${vendor}`;
  return "Flagged possible duplicate invoice";
}

function fallbackOvernightSummary(entry: DecisionAuditLogEntry): string {
  const agent = displayAgent(entry.agent);
  const decision = titleCase(entry.decision.replace(/[_-]+/g, " "));
  if (entry.event_action === "decision.escalated")
    return `${agent} escalated ${decision} for review`;
  if (entry.event_action === "decision.proposed") return `${agent} proposed ${decision}`;
  return `${agent} completed ${decision}`;
}

function fieldSources(entry: DecisionAuditLogEntry): Record<string, unknown>[] {
  return [
    readObject(entry.outcome["details"]) ?? {},
    readObject(entry.outcome["proposal_summary"]) ?? {},
    entry.outcome,
    entry.policy_context,
  ];
}

function stringField(
  entry: DecisionAuditLogEntry,
  ...paths: Array<Array<string | number>>
): string | undefined {
  for (const source of fieldSources(entry)) {
    for (const path of paths) {
      const value = readPath(source, path);
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function numberField(
  entry: DecisionAuditLogEntry,
  ...paths: Array<Array<string | number>>
): number | undefined {
  for (const source of fieldSources(entry)) {
    for (const path of paths) {
      const value = readPath(source, path);
      const parsed =
        typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function amountField(
  entry: DecisionAuditLogEntry,
  ...paths: Array<Array<string | number>>
): string | undefined {
  for (const path of paths) {
    const value = numberField(entry, path);
    if (value === undefined) continue;
    const pathName = String(path[path.length - 1]);
    const amount = pathName.endsWith("_cents") ? value / 100 : value;
    return formatMoney(amount, stringField(entry, ["currency"]) ?? "USD");
  }
  return undefined;
}

function percentField(
  entry: DecisionAuditLogEntry,
  ...paths: Array<Array<string | number>>
): string | undefined {
  const value = numberField(entry, ...paths);
  if (value === undefined) return undefined;
  return `${trimNumber(value)}%`;
}

function readPath(source: Record<string, unknown>, path: Array<string | number>): unknown {
  let value: unknown = source;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(value)) return undefined;
      value = value[key];
      continue;
    }
    const record = readObject(value);
    if (record === undefined) return undefined;
    value = record[key];
  }
  return value;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function formatMoney(amount: number, currency: string): string {
  const rounded = Math.abs(amount) >= 100 ? Math.round(amount) : amount;
  const formatted = rounded.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return currency === "USD" ? `$${formatted}` : `${currency} ${formatted}`;
}

function formatCount(value: number): string {
  return trimNumber(value);
}

function trimNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function runwayChangeWord(
  before: number | undefined,
  after: number | undefined,
): string | undefined {
  if (before === undefined || after === undefined) return undefined;
  if (after > before) return "extended";
  if (after < before) return "shortened";
  return "steady";
}

function briefMarkdown(
  signals: RoboBriefSignal[],
  highlights: RoboBriefHighlight[],
  overnightExecutions: number,
): string {
  const cash = signals.find((signal) => signal.key === "cash_on_hand");
  const net = signals.find((signal) => signal.key === "net_30_day");
  const runway = signals.find((signal) => signal.key === "runway_months");
  const lines = ["Good morning. Here is what changed while you were away."];
  if (cash?.key === "cash_on_hand") {
    lines.push(`Cash on hand is ${money(cash.value_cents, cash.currency)}.`);
  }
  if (net?.key === "net_30_day") {
    lines.push(`Net cash flow over the last 30 days is ${money(net.value_cents, net.currency)}.`);
  }
  if (runway?.key === "runway_months" && runway.value_months !== undefined) {
    lines.push(`Current runway is ${runway.value_months} months.`);
  }
  lines.push(`${overnightExecutions} decisions executed overnight.`);
  if (highlights.length > 0) {
    lines.push(`${highlights.length} inbox items need attention first.`);
  } else {
    lines.push("No urgent inbox items are waiting.");
  }
  return lines.join("\n\n");
}

function money(valueCents: number, currencyCode: string): string {
  const sign = valueCents < 0 ? "-" : "";
  const value = Math.abs(valueCents) / 100;
  return `${sign}${currencyCode} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function nextPrompts(
  highlights: RoboBriefHighlight[],
  signals: RoboBriefSignal[],
): RoboBriefNextPrompt[] {
  const prompts: RoboBriefNextPrompt[] = [];
  const first = highlights[0];
  if (first !== undefined) {
    prompts.push({
      label: "Review top inbox item",
      action: { kind: "open_proposal", target_id_or_prompt: first.proposal_id },
    });
  }
  if (signals.some((signal) => signal.key === "runway_months")) {
    prompts.push({
      label: "Model runway options",
      action: {
        kind: "ask_robo",
        target_id_or_prompt: "Model what keeps runway above 12 months.",
      },
    });
  }
  prompts.push({
    label: "Explain today",
    action: { kind: "ask_robo", target_id_or_prompt: "What should I focus on today?" },
  });
  return prompts.slice(0, 3);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function assertContextSource(value: unknown): asserts value is RoboContextSource {
  if (typeof value !== "object" || value === null) {
    throw brainError("request_body_invalid", "source is required");
  }
  const source = value as Partial<RoboContextSource>;
  if (source.kind !== "proposal_rail") {
    throw brainError("request_body_invalid", "source.kind must be proposal_rail");
  }
  for (const key of ["agent", "rail", "proposal_id"] as const) {
    if (typeof source[key] !== "string" || source[key]!.length === 0) {
      throw brainError("request_body_invalid", `source.${key} is required`);
    }
  }
}
