import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

export const amlComplianceHandler: InternalAgentHandler = {
  agent_key: "aml_compliance",
  actions: ["provide_docs", "delegate", "hold"],
  build(input: HandlerInput): ProposedAction {
    return buildAmlComplianceProposal(input);
  },
};

function buildAmlComplianceProposal(input: HandlerInput): ProposedAction {
  const paymentId =
    readString(input.context.payment_id) ||
    readString(input.context.payment_intent_id) ||
    readString(input.context.transaction_id);
  const beneficiaryId =
    readString(input.context.beneficiary_id) ||
    readString(input.context.destination_counterparty_id) ||
    readString(input.context.counterparty_id);
  const amount = readString(input.context.amount, "0.00");
  const currency = readString(input.context.currency, "USD").toUpperCase();
  const jurisdictions = readStringArray(input.context.jurisdictions_involved);
  const requiredDocuments = readRows(input.context.required_documents);
  const screenings = readObject(input.context.screenings) ?? defaultScreenings(input);
  const regulatoryContext = readObject(input.context.regulatory_context) ?? {
    jurisdiction: jurisdictions.join(":") || "unknown",
    regulation_id: "aml_default",
    threshold: "0.00",
    purpose_code_required: false,
  };
  const recommendedAction = actionFor(input.action, requiredDocuments, screenings);
  const deadline = readString(input.context.deadline) || defaultDeadline(input.now ?? new Date());
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);

  return {
    channel: "agent",
    action: {
      type: "aml_compliance",
      kind: "agent_action",
      agent_kind: "aml_compliance",
      payment_id: paymentId,
      beneficiary_id: beneficiaryId,
      amount,
      currency,
      jurisdictions_involved: jurisdictions,
      screenings,
      required_documents: requiredDocuments,
      regulatory_context: regulatoryContext,
      ...optionalRecordField("decision_context", input.context.decision_context),
      recommended_action: recommendedAction,
      decision_effect: decisionEffectFor(recommendedAction, input.context),
      deadline,
      narrative: narrativeFor(recommendedAction, amount, currency, beneficiaryId),
      summary: `AML compliance recommends ${recommendedAction.replaceAll("_", " ")}.`,
      risk_band: recommendedAction === "hold" ? "high" : "elevated",
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? "high",
      agent_id: input.definition?.agent_key ?? "aml_compliance",
      agent_role: input.definition?.agent_key ?? "aml_compliance",
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: input.definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function actionFor(
  action: string,
  requiredDocuments: readonly Record<string, unknown>[],
  screenings: Record<string, unknown>,
): "provide_docs" | "delegate" | "hold" {
  if (action === "delegate") return "delegate";
  if (action === "hold") return "hold";
  if (hasScreeningHit(screenings)) return "hold";
  if (requiredDocuments.some((row) => readString(row.status) !== "cleared")) return "provide_docs";
  return "provide_docs";
}

function hasScreeningHit(screenings: Record<string, unknown>): boolean {
  const values = [screenings["ofac"], screenings["pep"]];
  return values.some((value) => {
    const status = readString(readObject(value)?.["status"]);
    return status === "match" || status === "possible_match";
  });
}

function decisionEffectFor(
  action: "provide_docs" | "delegate" | "hold",
  context: Record<string, unknown>,
): Record<string, unknown> {
  if (action === "delegate") {
    return {
      kind: "emit_delegation_event",
      target_user_id: readString(context.delegate_to_user_id) || null,
    };
  }
  if (action === "hold") {
    return {
      kind: "pause_payment_intent",
      renotify_after: readString(context.renotify_after) || "P1D",
    };
  }
  return { kind: "mark_documents_attached" };
}

function defaultScreenings(input: HandlerInput): Record<string, unknown> {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ofac: { status: "unknown", lists_checked: [], timestamp: now },
    pep: { status: "unknown", matches: [] },
    kyc_freshness: { status: "unknown", note: "kyc_freshness_not_provided" },
  };
}

function narrativeFor(
  action: string,
  amount: string,
  currency: string,
  beneficiaryId: string,
): string {
  const beneficiary = beneficiaryId || "unknown";
  const actionLabel = action.replaceAll("_", " ");
  return (
    `Payment ${amount} ${currency} to beneficiary ${beneficiary} requires AML compliance review. ` +
    `Recommended action is ${actionLabel}.`
  );
}

function defaultDeadline(now: Date): string {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function readRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalRecordField(key: string, value: unknown): Record<string, unknown> {
  const row = readObject(value);
  return row !== null ? { [key]: row } : {};
}
