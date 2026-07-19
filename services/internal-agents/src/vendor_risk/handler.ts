import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

type RecommendedAction = "allow" | "verify" | "hold";
type RiskBand = "standard" | "elevated" | "high";

interface RiskSignal {
  readonly id: string;
  readonly label: string;
  readonly score: number;
}

interface VendorRiskScore {
  readonly riskScore: number;
  readonly riskBand: RiskBand;
  readonly recommendedAction: RecommendedAction;
  readonly triggeringSignals: readonly RiskSignal[];
}

/** Vendor Risk actions are advisory fraud-control proposals. They never move funds. */
export const vendorRiskHandler: InternalAgentHandler = {
  agent_key: "vendor_risk",
  actions: ["flag_vendor_risk", "require_approval", "block_payment", "escalate"],
  build(input: HandlerInput): ProposedAction {
    return buildVendorRiskProposal(input);
  },
};

function buildVendorRiskProposal(input: HandlerInput): ProposedAction {
  const vendorId = readString(input.context.vendor_id) || readString(input.context.counterparty_id);
  const vendorName = readString(input.context.vendor_name, vendorId || "unresolved vendor");
  const identityResolved = readBoolean(input.context.identity_resolved, vendorId.length > 0);
  const paymentDestination =
    readString(input.context.payment_destination_id) ||
    readString(input.context.payment_instruction_id) ||
    readString(input.context.payment_destination);
  const currentHash = readString(input.context.current_destination_hash);
  const priorHash = readString(input.context.prior_destination_hash);
  const score = scoreVendorRisk(input, { vendorId, identityResolved });
  const changedField = changedFieldFor(score.triggeringSignals);
  const actionType = score.recommendedAction === "hold" ? "block_payment" : input.action;
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);

  return {
    channel: "agent",
    action: {
      type: actionType,
      kind: "agent_action",
      vendor_id: vendorId || null,
      counterparty_id: vendorId || null,
      vendor_name: vendorName,
      payment_destination: paymentDestination || null,
      payment_destination_id: paymentDestination || null,
      changed_field: changedField,
      previous_value_hash: priorHash || null,
      new_value_hash: currentHash || null,
      risk_reason: riskReason(score),
      risk_band: score.riskBand,
      risk_score: score.riskScore,
      triggering_signals: score.triggeringSignals.map((signal) => signal.id),
      ranked_signals: score.triggeringSignals.map((signal) => ({
        id: signal.id,
        label: signal.label,
        score: signal.score,
      })),
      recommended_action: score.recommendedAction,
      narrative:
        `${vendorName} scored ${score.riskScore.toFixed(2)} vendor risk with ` +
        `${score.triggeringSignals.length === 0 ? "no risk signals" : score.triggeringSignals.map((s) => s.label).join(", ")}. ` +
        `Recommend ${score.recommendedAction}.`,
      summary: `${vendorName} vendor risk is ${score.riskBand}; recommend ${score.recommendedAction}.`,
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? "high",
      agent_id: input.definition?.agent_key ?? "vendor_risk",
      agent_role: input.definition?.agent_key ?? "vendor_risk",
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: input.definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function scoreVendorRisk(
  input: HandlerInput,
  identity: { readonly vendorId: string; readonly identityResolved: boolean },
): VendorRiskScore {
  const signals: RiskSignal[] = [];
  if (!identity.identityResolved || identity.vendorId.length === 0) {
    // Defensive path: the production scanner passes identity_resolved=true for
    // existing counterparties. Unverified vendors are scored through
    // verified_status in v1 until canonical vendor identity links are first class.
    signals.push({
      id: "identity_unresolved",
      label: "identity unresolved",
      score: 1,
    });
    return scoreFromSignals(signals);
  }

  if (isNewVendor(input)) {
    signals.push({ id: "newly_created_vendor", label: "new vendor", score: 0.25 });
  }
  if (hasRecentDestinationChange(input)) {
    signals.push({
      id: "recent_bank_detail_change",
      label: "recent bank detail change",
      score: 0.35,
    });
  }
  if (isUnverified(input)) {
    signals.push({ id: "unverified_identity", label: "unverified identity", score: 0.25 });
  }
  if (destinationChangedVsHistory(input)) {
    signals.push({
      id: "destination_changed_vs_history",
      label: "destination changed versus history",
      score: 0.25,
    });
  }
  if (nameDestinationMismatch(input)) {
    signals.push({
      id: "name_destination_mismatch",
      label: "name and destination mismatch",
      score: 0.2,
    });
  }
  if (hasRiskHistoryEvidence(input)) {
    signals.push({
      id: "counterparty_history_risk",
      label: "counterparty history risk",
      score: 0.45,
    });
  }
  return scoreFromSignals(signals);
}

function scoreFromSignals(signals: readonly RiskSignal[]): VendorRiskScore {
  const sorted = [...signals].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const riskScore = Math.min(1, round(sorted.reduce((sum, signal) => sum + signal.score, 0)));
  const riskBand: RiskBand =
    riskScore >= 0.7 ? "high" : riskScore >= 0.35 ? "elevated" : "standard";
  const recommendedAction: RecommendedAction =
    riskScore >= 0.7 ? "hold" : riskScore >= 0.35 ? "verify" : "allow";
  return { riskScore, riskBand, recommendedAction, triggeringSignals: sorted };
}

function isNewVendor(input: HandlerInput): boolean {
  return daysSince(input.context.created_at, input.now ?? new Date()) <= 7;
}

function hasRecentDestinationChange(input: HandlerInput): boolean {
  return daysSince(input.context.payment_destination_changed_at, input.now ?? new Date()) <= 7;
}

function isUnverified(input: HandlerInput): boolean {
  const status = readString(input.context.verified_status, "unverified");
  return status === "unverified" || status === "self_attested";
}

function destinationChangedVsHistory(input: HandlerInput): boolean {
  const prior = readString(input.context.prior_destination_hash);
  const current = readString(input.context.current_destination_hash);
  if (prior.length === 0 || current.length === 0) return false;
  return prior !== current;
}

function nameDestinationMismatch(input: HandlerInput): boolean {
  const vendorName = normalizeText(
    readString(input.context.vendor_name) || readString(input.context.counterparty_name),
  );
  const destinationName = normalizeText(readString(input.context.destination_name));
  if (vendorName.length === 0 || destinationName.length === 0) return false;
  return !destinationName.includes(vendorName) && !vendorName.includes(destinationName);
}

function hasRiskHistoryEvidence(input: HandlerInput): boolean {
  return input.evidence.items.some((item) => {
    if (item.kind !== "counterparty_history") return false;
    if (item.risk_flag === true) return true;
    if (item.severity === "high" || item.severity === "critical") return true;
    return typeof item.risk_score === "number" && item.risk_score >= 0.7;
  });
}

function changedFieldFor(signals: readonly RiskSignal[]): string {
  if (signals.some((signal) => signal.id === "recent_bank_detail_change")) return "bank_details";
  if (signals.some((signal) => signal.id === "destination_changed_vs_history")) {
    return "payment_destination";
  }
  if (signals.some((signal) => signal.id === "unverified_identity")) return "verified_status";
  if (signals.some((signal) => signal.id === "identity_unresolved")) return "identity";
  return "none";
}

function riskReason(score: VendorRiskScore): string {
  if (score.triggeringSignals.length === 0) return "no risk signals";
  return score.triggeringSignals.map((signal) => signal.label).join(", ");
}

function daysSince(raw: unknown, now: Date): number {
  if (typeof raw !== "string" || raw.length === 0) return Number.POSITIVE_INFINITY;
  const then = Date.parse(raw);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.floor(
    (startOfDay(now).getTime() - startOfDay(new Date(then)).getTime()) / 86_400_000,
  );
}

function startOfDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function __vendorRiskTestOnly(): { scoreVendorRisk: typeof scoreVendorRisk } {
  return { scoreVendorRisk };
}
