import { brainError } from "@brain/shared";
import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

type AnomalyType =
  | "duplicate_charge"
  | "unusual_amount"
  | "velocity_spike"
  | "merchant_risk"
  | "insufficient_history"
  | "none";
type RiskBand = "standard" | "elevated" | "high";
type RecommendedAction = "monitor" | "review" | "hold";

interface AnomalySignal {
  readonly id: AnomalyType;
  readonly label: string;
  readonly score: number;
}

interface AnomalyScore {
  readonly anomalyType: AnomalyType;
  readonly anomalyScore: number;
  readonly riskBand: RiskBand;
  readonly recommendedAction: RecommendedAction;
  readonly signals: readonly AnomalySignal[];
}

export const fraudAnomalyHandler: InternalAgentHandler = {
  agent_key: "fraud_anomaly",
  actions: ["flag_transaction", "notify", "freeze_card", "create_dispute_draft"],
  build(input: HandlerInput): ProposedAction {
    return buildFraudAnomalyProposal(input);
  },
};

function buildFraudAnomalyProposal(input: HandlerInput): ProposedAction {
  const transactionId = requiredString(input.context, "transaction_id");
  const amount = requiredNumber(input.context, "amount");
  const score = scoreFraudAnomaly(input, amount);
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);
  const actionType = score.recommendedAction === "monitor" ? "notify" : input.action;
  const counterpartyName =
    readString(input.context.counterparty_name) || readString(input.context.description);

  return {
    channel: "agent",
    action: {
      type: actionType,
      kind: "agent_action",
      transaction_id: transactionId,
      account_id: readString(input.context.account_id) || null,
      counterparty_id: readString(input.context.counterparty_id) || null,
      counterparty_name: counterpartyName || null,
      amount: amount.toFixed(2),
      currency: readString(input.context.currency, "USD").toUpperCase(),
      transaction_date: readString(input.context.transaction_date) || null,
      anomaly_type: score.anomalyType,
      anomaly_score: score.anomalyScore,
      risk_band: score.riskBand,
      recommended_action: score.recommendedAction,
      triggering_signals: score.signals.map((signal) => signal.id),
      ranked_signals: score.signals.map((signal) => ({
        id: signal.id,
        label: signal.label,
        score: signal.score,
      })),
      narrative: narrativeFor(score, transactionId, amount, counterpartyName),
      summary: summaryFor(score, transactionId),
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? "high",
      agent_id: input.definition?.agent_key ?? "fraud_anomaly",
      agent_role: input.definition?.agent_key ?? "fraud_anomaly",
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: input.definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function scoreFraudAnomaly(input: HandlerInput, amount: number): AnomalyScore {
  const historyCount = readNumber(input.context.history_count);
  const signals: AnomalySignal[] = [];

  const duplicateCount = readNumber(input.context.duplicate_count_7d);
  if (duplicateCount !== null && duplicateCount >= 1) {
    signals.push({ id: "duplicate_charge", label: "duplicate charge in 7 days", score: 0.95 });
  }

  const merchantRisk = readNumber(input.context.merchant_risk_score);
  if (merchantRisk !== null && merchantRisk >= 0.8) {
    signals.push({ id: "merchant_risk", label: "merchant risk detected", score: merchantRisk });
  }

  if (historyCount === null || historyCount < 3) {
    if (signals.length === 0) {
      signals.push({
        id: "insufficient_history",
        label: "insufficient transaction history",
        score: 0.1,
      });
    }
    return scoreFromSignals(signals);
  }

  const accountMean = readNumber(input.context.account_mean_amount);
  const counterpartyMean = readNumber(input.context.counterparty_mean_amount);
  const baseline = positiveMin(counterpartyMean, accountMean);
  if (baseline !== null) {
    const ratio = amount / baseline;
    if (ratio >= 10) {
      signals.push({ id: "unusual_amount", label: "amount at least 10x baseline", score: 0.9 });
    } else if (ratio >= 4) {
      signals.push({
        id: "unusual_amount",
        label: "amount materially above baseline",
        score: 0.72,
      });
    } else if (ratio >= 2.5) {
      signals.push({ id: "unusual_amount", label: "amount near anomaly threshold", score: 0.45 });
    }
  }

  const zScore = maxFinite(
    zScoreFor(amount, counterpartyMean, readNumber(input.context.counterparty_stddev_amount)),
    zScoreFor(amount, accountMean, readNumber(input.context.account_stddev_amount)),
  );
  if (zScore !== null) {
    if (zScore >= 4) {
      signals.push({ id: "unusual_amount", label: "amount z-score above 4", score: 0.85 });
    } else if (zScore >= 3) {
      signals.push({ id: "unusual_amount", label: "amount z-score above 3", score: 0.7 });
    } else if (zScore >= 2.5) {
      signals.push({ id: "unusual_amount", label: "amount z-score near threshold", score: 0.45 });
    }
  }

  const velocityCount = readNumber(input.context.velocity_count_24h);
  const avgDailyCount = readNumber(input.context.account_daily_count_avg);
  if (
    velocityCount !== null &&
    ((velocityCount >= 3 &&
      avgDailyCount !== null &&
      avgDailyCount > 0 &&
      velocityCount / avgDailyCount >= 4) ||
      velocityCount >= 5)
  ) {
    signals.push({ id: "velocity_spike", label: "transaction velocity spike", score: 0.65 });
  }

  if (signals.length === 0) {
    signals.push({ id: "none", label: "in-band transaction", score: 0 });
  }
  return scoreFromSignals(signals);
}

function scoreFromSignals(signals: readonly AnomalySignal[]): AnomalyScore {
  const sorted = [...signals].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const primary = sorted[0] ?? { id: "none" as const, score: 0, label: "in-band transaction" };
  const anomalyScore = round(
    Math.min(
      1,
      sorted.reduce((max, signal) => Math.max(max, signal.score), 0),
    ),
  );
  const riskBand: RiskBand =
    anomalyScore >= 0.8 ? "high" : anomalyScore >= 0.5 ? "elevated" : "standard";
  const recommendedAction: RecommendedAction =
    anomalyScore >= 0.8 ? "hold" : anomalyScore >= 0.5 ? "review" : "monitor";
  return {
    anomalyType: primary.id,
    anomalyScore,
    riskBand,
    recommendedAction,
    signals: sorted,
  };
}

function narrativeFor(
  score: AnomalyScore,
  transactionId: string,
  amount: number,
  counterpartyName: string,
): string {
  const merchant = counterpartyName.length > 0 ? ` at ${counterpartyName}` : "";
  if (score.recommendedAction === "monitor") {
    return `Transaction ${transactionId}${merchant} for ${amount.toFixed(2)} is in band. Recommend monitor.`;
  }
  return (
    `Transaction ${transactionId}${merchant} for ${amount.toFixed(2)} scored ` +
    `${score.anomalyScore.toFixed(2)} fraud anomaly risk from ${score.signals
      .filter((signal) => signal.score > 0)
      .map((signal) => signal.label)
      .join(", ")}. Recommend ${score.recommendedAction}.`
  );
}

function summaryFor(score: AnomalyScore, transactionId: string): string {
  return `${transactionId} fraud anomaly risk is ${score.riskBand}; recommend ${score.recommendedAction}.`;
}

function requiredString(context: Record<string, unknown>, key: string): string {
  const value = readString(context[key]);
  if (value.length > 0) return value;
  throw brainError("request_body_invalid", `${key} is required`);
}

function requiredNumber(context: Record<string, unknown>, key: string): number {
  const value = readNumber(context[key]);
  if (value !== null && value > 0) return value;
  throw brainError("request_body_invalid", `${key} must be a positive number`);
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveMin(a: number | null, b: number | null): number | null {
  const values = [a, b].filter((value): value is number => value !== null && value > 0);
  if (values.length === 0) return null;
  return Math.min(...values);
}

function zScoreFor(value: number, mean: number | null, stddev: number | null): number | null {
  if (mean === null || stddev === null || stddev <= 0) return null;
  return (value - mean) / stddev;
}

function maxFinite(...values: Array<number | null>): number | null {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (finite.length === 0) return null;
  return Math.max(...finite);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
