import { brainError } from "@brain/shared";
import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

type FindingType = "duplicate" | "structuring" | "threshold_avoidance" | "new_vendor";

export const invoiceIntegrityHandler: InternalAgentHandler = {
  agent_key: "invoice_integrity",
  actions: [
    "flag_duplicate_invoice",
    "flag_structuring",
    "flag_threshold_avoidance",
    "flag_unverified_vendor",
  ],
  build(input: HandlerInput): ProposedAction {
    return buildInvoiceIntegrityProposal(input);
  },
};

function buildInvoiceIntegrityProposal(input: HandlerInput): ProposedAction {
  const obligationId = requiredString(input.context, "obligation_id");
  const amount = requiredNumber(input.context, "amount");
  const currency = readString(input.context.currency, "USD").toUpperCase();
  const counterpartyId = readString(input.context.counterparty_id) || null;
  const counterpartyName = readString(input.context.counterparty_name) || null;
  const findingType = findingTypeFor(input.action);
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);

  return {
    channel: "agent",
    action: {
      type: input.action,
      kind: "agent_action",
      obligation_id: obligationId,
      counterparty_id: counterpartyId,
      counterparty_name: counterpartyName,
      amount: amount.toFixed(2),
      currency,
      due_date: readString(input.context.due_date) || null,
      finding_type: findingType,
      related_obligation_ids: readStringArray(input.context.related_obligation_ids),
      narrative: narrativeFor(findingType, obligationId, amount, currency, input.context),
      summary: summaryFor(findingType, obligationId),
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? "high",
      agent_id: input.definition?.agent_key ?? "invoice_integrity",
      agent_role: input.definition?.agent_key ?? "invoice_integrity",
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: input.definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function findingTypeFor(action: string): FindingType {
  switch (action) {
    case "flag_duplicate_invoice":
      return "duplicate";
    case "flag_structuring":
      return "structuring";
    case "flag_threshold_avoidance":
      return "threshold_avoidance";
    case "flag_unverified_vendor":
      return "new_vendor";
    default:
      throw brainError("request_body_invalid", `unsupported invoice_integrity action: ${action}`);
  }
}

function narrativeFor(
  findingType: FindingType,
  obligationId: string,
  amount: number,
  currency: string,
  context: Record<string, unknown>,
): string {
  const amountLabel = `${currency} ${amount.toFixed(2)}`;
  switch (findingType) {
    case "duplicate": {
      const related = readStringArray(context.related_obligation_ids);
      const relatedLabel = related.length > 0 ? related.join(", ") : "another obligation";
      return (
        `Obligation ${obligationId} for ${amountLabel} matches the same counterparty, amount, ` +
        `and due date as ${relatedLabel}. Likely a duplicate invoice.`
      );
    }
    case "structuring": {
      const group = readStringArray(context.related_obligation_ids);
      const total = readString(context.group_total_amount);
      return (
        `Obligation ${obligationId} for ${amountLabel} is one of ${group.length + 1} obligations ` +
        `to the same counterparty on the same due date (${group.join(", ") || "none listed"}), ` +
        `totaling ${currency} ${total.length > 0 ? total : "an unknown amount"}. ` +
        `Possible structuring / split-payment pattern.`
      );
    }
    case "threshold_avoidance": {
      const threshold = readString(context.threshold_amount);
      return (
        `Obligation ${obligationId} for ${amountLabel} sits just below the ` +
        `${currency} ${threshold.length > 0 ? threshold : "approval"} threshold. ` +
        `Possible threshold avoidance.`
      );
    }
    case "new_vendor": {
      const status = readString(context.counterparty_verified_status) || "unverified";
      return (
        `Obligation ${obligationId} for ${amountLabel} is owed to a ${status} counterparty with ` +
        `no prior payment history. High-value obligation to an unverified vendor.`
      );
    }
  }
}

function summaryFor(findingType: FindingType, obligationId: string): string {
  const labels: Record<FindingType, string> = {
    duplicate: "possible duplicate invoice",
    structuring: "possible structuring pattern",
    threshold_avoidance: "possible threshold avoidance",
    new_vendor: "high-value obligation to unverified vendor",
  };
  return `${obligationId}: ${labels[findingType]}.`;
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
