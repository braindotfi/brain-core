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

type Recommendation = {
  recommendedAction: "draft_followup" | "create_task" | "escalate" | "propose_payment_plan";
  escalationTier: "reminder" | "task" | "escalation" | "payment_plan";
  riskBand: "standard" | "elevated" | "high";
  tone: "friendly" | "firm" | "urgent" | "collaborative";
  nextEscalationDays: number;
};

/** Collections actions are non-financial: they draft, send, task, escalate, or
 *  propose a payment plan. None move money, so all go through IAgentService. */
export const collectionsHandler: InternalAgentHandler = {
  agent_key: "collections",
  actions: ["draft_followup", "send_followup", "create_task", "escalate", "propose_payment_plan"],
  build(input: HandlerInput): ProposedAction {
    return buildCollectionsProposal(input);
  },
};

function buildCollectionsProposal(input: HandlerInput): ProposedAction {
  const invoiceId = requireStringField(input.context, "invoice_id");
  const counterpartyId = requireStringField(input.context, "counterparty_id");
  const amount = requireDecimalAmount(input.context, "amount");
  const currency = requireCurrency(input.context, "currency");
  const dueDate = requireStringField(input.context, "due_date");
  const daysOverdue = requirePositiveInteger(input.context, "days_overdue");
  const agingTier = readString(input.context.aging_tier) || agingTierFor(daysOverdue);
  const counterpartyName = readString(input.context.counterparty_name, counterpartyId);
  const invoiceNumber = readString(input.context.invoice_number, displayInvoiceId(invoiceId));
  const recommendation = recommendationFor(daysOverdue, input.action);
  const nextEscalationDate = addDaysIso(input.now ?? new Date(), recommendation.nextEscalationDays);
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);

  return {
    channel: "agent",
    action: {
      type: "collections",
      kind: "agent_action",
      invoice_id: invoiceId,
      counterparty_id: counterpartyId,
      counterparty_name: counterpartyName,
      invoice_number: invoiceNumber,
      amount_due: amount,
      currency,
      due_date: dueDate,
      days_overdue: daysOverdue,
      aging_tier: agingTier,
      recommended_action: recommendation.recommendedAction,
      escalation_tier: recommendation.escalationTier,
      ranked_recommendations: rankedRecommendations(daysOverdue, recommendation.recommendedAction),
      recommended_tone: recommendation.tone,
      draft_message: draftMessage({
        counterpartyName,
        invoiceNumber,
        amount,
        currency,
        daysOverdue,
        tone: recommendation.tone,
      }),
      next_escalation_date: nextEscalationDate,
      narrative:
        `${counterpartyName} has ${amount} ${currency} outstanding on invoice ${invoiceNumber}, ` +
        `${daysOverdue} days overdue. Recommend ${recommendation.recommendedAction} with ` +
        `${recommendation.tone} tone and ${recommendation.escalationTier} escalation.`,
      summary: `${amount} ${currency} receivable is ${daysOverdue} days overdue for ${counterpartyName}.`,
      risk_band: recommendation.riskBand,
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? null,
      agent_id: input.definition?.agent_key ?? "collections",
      agent_role: input.definition?.agent_key ?? "collections",
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: input.definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function requirePositiveInteger(context: Record<string, unknown>, field: string): number {
  const raw = context[field];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (Number.isInteger(value) && value > 0) return value;
  throw brainError("request_body_invalid", `${field} must be a positive integer`);
}

function recommendationFor(daysOverdue: number, requestedAction: string): Recommendation {
  if (daysOverdue >= 60) {
    return {
      recommendedAction: "propose_payment_plan",
      escalationTier: "payment_plan",
      riskBand: "high",
      tone: "collaborative",
      nextEscalationDays: 3,
    };
  }
  if (daysOverdue >= 30 || requestedAction === "escalate") {
    return {
      recommendedAction: "escalate",
      escalationTier: "escalation",
      riskBand: "high",
      tone: "urgent",
      nextEscalationDays: 2,
    };
  }
  if (daysOverdue >= 15 || requestedAction === "create_task") {
    return {
      recommendedAction: "create_task",
      escalationTier: "task",
      riskBand: "elevated",
      tone: "firm",
      nextEscalationDays: 5,
    };
  }
  return {
    recommendedAction: "draft_followup",
    escalationTier: "reminder",
    riskBand: "standard",
    tone: "friendly",
    nextEscalationDays: 7,
  };
}

function rankedRecommendations(
  daysOverdue: number,
  recommendedAction: Recommendation["recommendedAction"],
): string[] {
  const ordered =
    daysOverdue >= 60
      ? ["propose_payment_plan", "escalate", "create_task", "draft_followup"]
      : daysOverdue >= 30
        ? ["escalate", "create_task", "propose_payment_plan", "draft_followup"]
        : daysOverdue >= 15
          ? ["create_task", "draft_followup", "escalate", "propose_payment_plan"]
          : ["draft_followup", "create_task", "escalate", "propose_payment_plan"];
  return [recommendedAction, ...ordered.filter((candidate) => candidate !== recommendedAction)];
}

function agingTierFor(daysOverdue: number): string {
  if (daysOverdue >= 90) return "90_plus";
  if (daysOverdue >= 60) return "60_89";
  if (daysOverdue >= 30) return "30_59";
  if (daysOverdue >= 15) return "15_29";
  return "1_14";
}

function displayInvoiceId(invoiceId: string): string {
  return invoiceId.replace(/^inv_/, "INV-").toUpperCase();
}

function addDaysIso(base: Date, days: number): string {
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function draftMessage(input: {
  counterpartyName: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  daysOverdue: number;
  tone: Recommendation["tone"];
}): string {
  const prefix =
    input.tone === "friendly"
      ? "Friendly reminder"
      : input.tone === "firm"
        ? "Following up"
        : input.tone === "urgent"
          ? "Urgent follow-up"
          : "Payment plan follow-up";
  return (
    `${prefix}: ${input.invoiceNumber} for ${input.amount} ${input.currency} is ` +
    `${input.daysOverdue} days overdue. Please confirm payment timing for ${input.counterpartyName}.`
  );
}
