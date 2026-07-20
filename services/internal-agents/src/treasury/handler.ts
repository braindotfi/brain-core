import { brainError } from "@brain/shared";
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

type TreasuryRecommendedAction =
  | "recommend_cash_sweep"
  | "alert_low_balance"
  | "create_liquidity_plan";

/**
 * Treasury actions. `propose_transfer` moves money, so it goes through
 * IPaymentIntentService.create (and thus Policy + the §6 gate). The rest are
 * advisory and go through IAgentService.propose.
 */
export const treasuryHandler: InternalAgentHandler = {
  agent_key: "treasury",
  actions: [
    "recommend_cash_sweep",
    "propose_transfer",
    "alert_low_balance",
    "create_liquidity_plan",
  ],
  build(input: HandlerInput): ProposedAction {
    if (input.action === "propose_transfer") {
      const c = input.context;
      const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);
      return {
        channel: "payment_intent",
        intent: {
          action_type: "onchain_transfer",
          source_account_id: requireStringField(c, "source_account_id"),
          destination_counterparty_id: requireStringField(c, "destination_counterparty_id"),
          amount: requireDecimalAmount(c, "amount"),
          currency: requireCurrency(c, "currency"),
          ...(confidence !== null ? { confidence } : {}),
          evidence_score: input.evidence.evidence_score,
          ...(input.definition?.risk_level !== undefined
            ? { risk_level: input.definition.risk_level }
            : {}),
          evidence_ids: input.evidence.items.map((i) => i.ref),
        },
      };
    }
    return buildTreasuryAdvisory(input);
  },
};

function buildTreasuryAdvisory(input: HandlerInput): ProposedAction {
  const accountId =
    optionalString(input.context.account_id) ??
    optionalString(input.context.source_account_id) ??
    requireStringField(input.context, "balance_id");
  const balanceId = requireStringField(input.context, "balance_id");
  const availableCash = requireMoney(input.context, "current_balance");
  const currency = requireCurrency(input.context, "currency");
  const thresholds = readThresholds(input.context.thresholds);
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);
  const sweepAmount = Math.max(availableCash - thresholds.operatingMinimum, 0);
  const recommended = recommendedActionFor(input.action, availableCash, thresholds);
  const riskBand = recommended === "alert_low_balance" ? "high" : "standard";
  const recommendedTransfer =
    recommended === "recommend_cash_sweep" ? formatMoney(sweepAmount) : "0.00";

  return {
    channel: "agent",
    action: {
      type: "treasury",
      kind: "agent_action",
      balance_id: balanceId,
      source_account_id: accountId,
      target_account_id: optionalString(input.context.target_account_id) ?? null,
      available_cash: formatMoney(availableCash),
      minimum_operating_cash: formatMoney(thresholds.operatingMinimum),
      recommended_transfer: recommendedTransfer,
      sweep_amount: recommendedTransfer,
      currency,
      operating_minimum: formatMoney(thresholds.operatingMinimum),
      surplus_floor: formatMoney(thresholds.surplusFloor),
      low_balance_floor: formatMoney(thresholds.lowBalanceFloor),
      liquidity_risk: riskBand,
      expected_yield: optionalString(input.context.expected_yield) ?? "unknown",
      recommended_action: recommended,
      narrative: narrativeFor(
        recommended,
        availableCash,
        currency,
        thresholds,
        recommendedTransfer,
      ),
      summary: `${recommended} for ${currency} balance ${formatMoney(availableCash)}.`,
      risk_band: riskBand,
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? null,
      agent_id: input.definition?.agent_key ?? "treasury",
      agent_role: input.definition?.agent_key ?? "treasury",
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: recommended === "alert_low_balance" ? "notify_only" : "propose",
    },
  };
}

function recommendedActionFor(
  action: string,
  availableCash: number,
  thresholds: {
    readonly operatingMinimum: number;
    readonly lowBalanceFloor: number;
    readonly surplusFloor: number;
  },
): TreasuryRecommendedAction {
  if (action === "alert_low_balance") return "alert_low_balance";
  if (action === "create_liquidity_plan") return "create_liquidity_plan";
  if (availableCash <= thresholds.lowBalanceFloor) return "alert_low_balance";
  if (availableCash >= thresholds.surplusFloor) return "recommend_cash_sweep";
  return "create_liquidity_plan";
}

function readThresholds(raw: unknown): {
  readonly operatingMinimum: number;
  readonly lowBalanceFloor: number;
  readonly surplusFloor: number;
} {
  const row = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const operatingMinimum = optionalMoney(row.operating_minimum) ?? 25_000;
  return {
    operatingMinimum,
    lowBalanceFloor: optionalMoney(row.low_balance_floor) ?? operatingMinimum,
    surplusFloor: optionalMoney(row.surplus_floor) ?? operatingMinimum * 2,
  };
}

function narrativeFor(
  action: TreasuryRecommendedAction,
  availableCash: number,
  currency: string,
  thresholds: {
    readonly operatingMinimum: number;
    readonly lowBalanceFloor: number;
    readonly surplusFloor: number;
  },
  recommendedTransfer: string,
): string {
  if (action === "alert_low_balance") {
    return `${currency} balance ${formatMoney(availableCash)} is at or below low balance floor ${formatMoney(thresholds.lowBalanceFloor)}. Human review should confirm liquidity coverage.`;
  }
  if (action === "recommend_cash_sweep") {
    return `${currency} balance ${formatMoney(availableCash)} exceeds surplus floor ${formatMoney(thresholds.surplusFloor)}. Recommended advisory sweep amount is ${recommendedTransfer}.`;
  }
  return `${currency} balance ${formatMoney(availableCash)} is between low and surplus thresholds. Build a liquidity plan before moving cash.`;
}

function requireMoney(context: Record<string, unknown>, field: string): number {
  const raw = context[field];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (Number.isFinite(value) && value >= 0) return value;
  throw brainError("request_body_invalid", `${field} is required`);
}

function optionalMoney(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

function optionalString(raw: unknown): string | null {
  const value = readString(raw);
  return value.length > 0 ? value : null;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}
