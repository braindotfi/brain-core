import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  requireCurrency,
  requireStringField,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";
import { brainError } from "@brain/shared";

type RevenueTrend = "up" | "down" | "flat";

/** Revenue Intelligence actions recommend, flag, and summarize; none move money,
 *  so all go through IAgentService.propose. */
export const revenueIntelHandler: InternalAgentHandler = {
  agent_key: "revenue_intel",
  actions: [
    "recommend_follow_up",
    "flag_churn_risk",
    "identify_expansion_opportunity",
    "create_revenue_summary",
  ],
  build(input: HandlerInput): ProposedAction {
    return buildRevenueIntelProposal(input);
  },
};

function buildRevenueIntelProposal(input: HandlerInput): ProposedAction {
  requireEvidence(input);
  const invoiceId = requireStringField(input.context, "invoice_id");
  const transactionId = requireStringField(input.context, "transaction_id");
  const currency = requireCurrency(input.context, "currency");
  const currentRevenue = requireNumber(
    input.context.current_period_revenue,
    "current_period_revenue",
  );
  const priorRevenue = requireNumber(input.context.prior_period_revenue, "prior_period_revenue");
  const currentDso = readNumber(input.context.current_dso, 0);
  const priorDso = readNumber(input.context.prior_dso, 0);
  const revenueDelta = currentRevenue - priorRevenue;
  const revenueDeltaPercent =
    priorRevenue === 0 ? (currentRevenue > 0 ? 100 : 0) : (revenueDelta / priorRevenue) * 100;
  const revenueTrend = trendFor(revenueDeltaPercent);
  const atRiskCustomers = atRiskCustomersFor(input.context, currentDso, priorDso);
  const upcomingRenewals = readRows(input.context.upcoming_renewals);
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);

  return {
    channel: "agent",
    action: {
      type: input.action,
      kind: "agent_action",
      agent_kind: "revenue_intel",
      invoice_id: invoiceId,
      transaction_id: transactionId,
      period: readString(input.context.period, "current"),
      segment: readString(input.context.segment, "all_customers"),
      currency,
      current_period_revenue: formatMoney(currentRevenue),
      prior_period_revenue: formatMoney(priorRevenue),
      revenue_delta: formatMoney(revenueDelta),
      revenue_delta_percent: round(revenueDeltaPercent),
      revenue_trend: revenueTrend,
      current_dso: round(currentDso),
      prior_dso: round(priorDso),
      dso_delta: round(currentDso - priorDso),
      at_risk_customers: atRiskCustomers,
      at_risk_customer_count: atRiskCustomers.length,
      upcoming_renewals: upcomingRenewals,
      upcoming_renewal_count: upcomingRenewals.length,
      top_movers: [
        {
          invoice_id: invoiceId,
          transaction_id: transactionId,
          revenue_delta: formatMoney(revenueDelta),
          revenue_delta_percent: round(revenueDeltaPercent),
        },
      ],
      anomalies: revenueTrend === "down" || currentDso - priorDso >= 10 ? atRiskCustomers : [],
      forecast_adjustments: [],
      narrative: narrativeFor({
        trend: revenueTrend,
        revenueDelta,
        currency,
        atRiskCustomerCount: atRiskCustomers.length,
        upcomingRenewalCount: upcomingRenewals.length,
      }),
      summary: `Revenue trend ${revenueTrend} with ${atRiskCustomers.length} at-risk customers.`,
      risk_band: atRiskCustomers.length > 0 || revenueTrend === "down" ? "elevated" : "standard",
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? "low",
      agent_id: input.definition?.agent_key ?? "revenue_intel",
      agent_role: input.definition?.agent_key ?? "revenue_intel",
      evidence_refs: [
        ...evidenceRefsForAction(input.evidence.items),
        { kind: "invoice", ref: invoiceId },
        { kind: "transaction", ref: transactionId },
      ],
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: input.definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function requireEvidence(input: HandlerInput): void {
  const kinds = new Set(input.evidence.items.map((item) => item.kind));
  if (
    input.evidence.critical_missing ||
    input.evidence.missing_required_evidence.length > 0 ||
    !kinds.has("invoice") ||
    !kinds.has("transaction")
  ) {
    throw new Error("revenue_intel_required_evidence_missing");
  }
}

function trendFor(deltaPercent: number): RevenueTrend {
  if (deltaPercent > 5) return "up";
  if (deltaPercent < -5) return "down";
  return "flat";
}

function atRiskCustomersFor(
  context: Record<string, unknown>,
  currentDso: number,
  priorDso: number,
): Array<{ counterparty_id: string; reason: string; dso_delta: number }> {
  const explicit = readRows(context.at_risk_customers);
  if (explicit.length > 0) {
    return explicit
      .map((row) => {
        const counterpartyId = readString(row.counterparty_id);
        return counterpartyId.length > 0
          ? {
              counterparty_id: counterpartyId,
              reason: readString(row.reason, "payment_behavior_worsened"),
              dso_delta: readNumber(row.dso_delta, currentDso - priorDso),
            }
          : null;
      })
      .filter(
        (row): row is { counterparty_id: string; reason: string; dso_delta: number } =>
          row !== null,
      );
  }
  const counterpartyId = readString(context.counterparty_id);
  const delta = currentDso - priorDso;
  return counterpartyId.length > 0 && delta >= 10
    ? [
        {
          counterparty_id: counterpartyId,
          reason: "payment_behavior_worsened",
          dso_delta: round(delta),
        },
      ]
    : [];
}

function readRows(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw)
    ? raw.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

function requireNumber(value: unknown, field: string): number {
  const parsed = readNumber(value, Number.NaN);
  if (!Number.isFinite(parsed)) {
    throw brainError("request_body_invalid", `${field} is required`);
  }
  return parsed;
}

function readNumber(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

function narrativeFor(input: {
  readonly trend: RevenueTrend;
  readonly revenueDelta: number;
  readonly currency: string;
  readonly atRiskCustomerCount: number;
  readonly upcomingRenewalCount: number;
}): string {
  return (
    `Revenue is ${input.trend} by ${input.currency} ${formatMoney(input.revenueDelta)}. ` +
    `${input.atRiskCustomerCount} customer payment behavior flag(s) and ` +
    `${input.upcomingRenewalCount} upcoming renewal(s) need review.`
  );
}
