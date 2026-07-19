import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  requireCurrency,
  requireDecimalAmount,
  requireStringField,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";
import { brainError } from "@brain/shared";

type SubscriptionAction = "flag_subscription" | "review_price_change" | "monitor";

/** Subscription actions are advisory (flag, recommend, draft, report); none move
 *  money, so all go through IAgentService.propose. */
export const subscriptionHandler: InternalAgentHandler = {
  agent_key: "subscription",
  actions: ["flag_subscription", "recommend_cancel", "draft_vendor_email", "create_savings_report"],
  build(input: HandlerInput): ProposedAction {
    return buildSubscriptionProposal(input);
  },
};

function buildSubscriptionProposal(input: HandlerInput): ProposedAction {
  requireEvidence(input);
  const transactionId = requireStringField(input.context, "transaction_id");
  const counterpartyId = requireStringField(input.context, "counterparty_id");
  const amount = Number(requireDecimalAmount(input.context, "amount"));
  const currency = requireCurrency(input.context, "currency");
  const transactionDate = requireStringField(input.context, "transaction_date");
  const history = readHistory(input.context.history);
  if (history.length < 3) {
    throw new Error("subscription_required_history_missing");
  }
  const detection = detectSubscription(history, amount, transactionDate);
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);

  return {
    channel: "agent",
    action: {
      type: input.action,
      kind: "agent_action",
      agent_kind: "subscription",
      transaction_id: transactionId,
      counterparty_id: counterpartyId,
      amount: formatMoney(amount),
      currency,
      is_subscription: detection.isSubscription,
      cadence: detection.cadence,
      next_expected_date: detection.nextExpectedDate,
      price_change_percent: detection.priceChangePercent,
      recommended_action: detection.recommendedAction,
      history_count: history.length,
      narrative: narrativeFor(detection),
      summary: `Subscription detection ${detection.isSubscription ? "matched" : "not_matched"}.`,
      risk_band: detection.recommendedAction === "review_price_change" ? "elevated" : "standard",
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? "low",
      agent_id: input.definition?.agent_key ?? "subscription",
      agent_role: input.definition?.agent_key ?? "subscription",
      evidence_refs: [
        ...evidenceRefsForAction(input.evidence.items),
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
    !kinds.has("transaction")
  ) {
    throw new Error("subscription_required_evidence_missing");
  }
}

interface HistoryCharge {
  readonly id: string;
  readonly amount: number;
  readonly date: string;
}

interface Detection {
  readonly isSubscription: boolean;
  readonly cadence: string | null;
  readonly nextExpectedDate: string | null;
  readonly priceChangePercent: number | null;
  readonly recommendedAction: SubscriptionAction;
}

function detectSubscription(
  history: readonly HistoryCharge[],
  amount: number,
  transactionDate: string,
): Detection {
  const sorted = [...history].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const intervals = sorted.slice(1).map((row, index) => daysBetween(sorted[index]!.date, row.date));
  const avgInterval = average(intervals);
  const regularCadence =
    avgInterval >= 25 &&
    avgInterval <= 35 &&
    intervals.every((d) => Math.abs(d - avgInterval) <= 5);
  const prior = sorted.slice(0, -1);
  const priorAverage = average(prior.map((row) => row.amount));
  const amountSimilar = priorAverage > 0 && Math.abs(amount - priorAverage) / priorAverage <= 0.1;
  if (!regularCadence) {
    return {
      isSubscription: false,
      cadence: null,
      nextExpectedDate: null,
      priceChangePercent: null,
      recommendedAction: "monitor",
    };
  }
  const priceChangePercent =
    priorAverage > 0 ? round(((amount - priorAverage) / priorAverage) * 100) : null;
  const priceChanged = priceChangePercent !== null && priceChangePercent >= 15;
  const isSubscription = amountSimilar || priceChanged;
  return {
    isSubscription,
    cadence: "monthly",
    nextExpectedDate: dateOnly(addDays(new Date(transactionDate), Math.round(avgInterval || 30))),
    priceChangePercent,
    recommendedAction: priceChanged
      ? "review_price_change"
      : isSubscription
        ? "flag_subscription"
        : "monitor",
  };
}

function readHistory(raw: unknown): HistoryCharge[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw brainError("request_body_invalid", `history[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    const id = readString(row.transaction_id) || readString(row.id) || `history_${index}`;
    const amount = Number(readString(row.amount));
    const date = readString(row.transaction_date) || readString(row.date);
    if (!Number.isFinite(amount) || Number.isNaN(Date.parse(date))) {
      throw brainError("request_body_invalid", `history[${index}] must have amount and date`);
    }
    return { id, amount, date };
  });
}

function narrativeFor(detection: Detection): string {
  if (!detection.isSubscription) {
    return "Recurring-charge review did not find a reliable subscription pattern.";
  }
  if (detection.recommendedAction === "review_price_change") {
    return `Recurring monthly charge detected with a ${detection.priceChangePercent} percent price change.`;
  }
  return `Recurring monthly charge detected. Next expected date is ${detection.nextExpectedDate}.`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}
