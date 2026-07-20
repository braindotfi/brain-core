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

type DisputeRecommendation = "gather_evidence" | "contest" | "accept";

/** Dispute actions assemble evidence and draft responses; none move money, so
 *  all go through IAgentService.propose. Evidence refs (Wiki + Raw) ride along. */
export const disputeHandler: InternalAgentHandler = {
  agent_key: "dispute",
  actions: ["gather_evidence", "draft_response", "escalate", "create_dispute_packet"],
  build(input: HandlerInput): ProposedAction {
    return buildDisputeProposal(input);
  },
};

function buildDisputeProposal(input: HandlerInput): ProposedAction {
  requireEvidence(input);
  const disputeId = requireStringField(input.context, "dispute_id");
  const transactionId = requireStringField(input.context, "transaction_id");
  const amount = Number(requireDecimalAmount(input.context, "amount"));
  const currency = requireCurrency(input.context, "currency");
  const deadline = requireStringField(input.context, "deadline");
  const ageDays = readNumber(input.context.dispute_age_days, 0);
  const evidenceCompleteness = readNumber(input.context.evidence_completeness, 0);
  const now = input.now ?? new Date();
  const daysToDeadline = Math.ceil((Date.parse(deadline) - now.getTime()) / 86_400_000);
  const recommendedAction = recommend({ amount, ageDays, evidenceCompleteness, daysToDeadline });
  const checklist = checklistFor(input.context, evidenceCompleteness);
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);

  return {
    channel: "agent",
    action: {
      type: input.action,
      kind: "agent_action",
      agent_kind: "dispute",
      dispute_id: disputeId,
      transaction_id: transactionId,
      dispute_reason: readString(input.context.dispute_reason, "chargeback_or_payment_mismatch"),
      amount: formatMoney(amount),
      currency,
      deadline,
      days_to_deadline: daysToDeadline,
      dispute_age_days: ageDays,
      evidence_completeness: round(evidenceCompleteness),
      evidence_bundle: checklist,
      evidence_checklist: checklist,
      recommended_action: recommendedAction,
      narrative: narrativeFor(recommendedAction, {
        disputeId,
        transactionId,
        amount,
        currency,
        daysToDeadline,
        evidenceCompleteness,
      }),
      summary: `Dispute ${disputeId} recommendation ${recommendedAction}.`,
      risk_band: recommendedAction === "contest" ? "elevated" : "standard",
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? "medium",
      agent_id: input.definition?.agent_key ?? "dispute",
      agent_role: input.definition?.agent_key ?? "dispute",
      evidence_refs: [
        ...evidenceRefsForAction(input.evidence.items),
        { kind: "dispute", ref: disputeId },
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
    !kinds.has("dispute") ||
    !kinds.has("transaction")
  ) {
    throw new Error("dispute_required_evidence_missing");
  }
}

function recommend(input: {
  readonly amount: number;
  readonly ageDays: number;
  readonly evidenceCompleteness: number;
  readonly daysToDeadline: number;
}): DisputeRecommendation {
  if (input.evidenceCompleteness < 0.8 || input.daysToDeadline <= 3) return "gather_evidence";
  if (input.amount < 100 && input.ageDays >= 45) return "accept";
  if (input.amount >= 500 && input.evidenceCompleteness >= 0.8) return "contest";
  return "gather_evidence";
}

function checklistFor(
  context: Record<string, unknown>,
  evidenceCompleteness: number,
): Array<{ item: string; present: boolean }> {
  const raw = context.evidence_checklist;
  if (Array.isArray(raw)) {
    return raw.map((item) => ({
      item: readString(item, "unknown"),
      present: true,
    }));
  }
  return [
    { item: "transaction_record", present: true },
    { item: "customer_communication", present: evidenceCompleteness >= 0.5 },
    { item: "fulfillment_or_service_proof", present: evidenceCompleteness >= 0.8 },
  ];
}

function narrativeFor(
  action: DisputeRecommendation,
  input: {
    readonly disputeId: string;
    readonly transactionId: string;
    readonly amount: number;
    readonly currency: string;
    readonly daysToDeadline: number;
    readonly evidenceCompleteness: number;
  },
): string {
  return (
    `Dispute ${input.disputeId} on transaction ${input.transactionId} is ${input.currency} ` +
    `${formatMoney(input.amount)} with ${input.daysToDeadline} days to deadline and ` +
    `${Math.round(input.evidenceCompleteness * 100)} percent evidence completeness. ` +
    `Recommended action is ${action}.`
  );
}

function readNumber(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  if (!Number.isFinite(value)) {
    throw brainError("request_body_invalid", "amount must be finite");
  }
  return value.toFixed(2);
}
