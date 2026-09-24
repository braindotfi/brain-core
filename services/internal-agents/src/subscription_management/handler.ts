import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

export const subscriptionManagementHandler: InternalAgentHandler = {
  agent_key: "subscription_management",
  actions: ["downgrade", "renegotiate", "cancel", "renew"],
  build(input: HandlerInput): ProposedAction {
    return buildSubscriptionManagementProposal(input);
  },
};

function buildSubscriptionManagementProposal(input: HandlerInput): ProposedAction {
  const subscriptionId =
    readString(input.context.subscription_id) || readString(input.context.transaction_id);
  const merchant =
    readString(input.context.merchant) ||
    readString(input.context.counterparty_name) ||
    readString(input.context.counterparty_id, "unknown merchant");
  const currency = readString(input.context.currency, "USD").toUpperCase();
  const currentPrice =
    readString(input.context.current_price) || readString(input.context.amount, "0.00");
  const currentPlan = readString(input.context.current_plan, "current");
  const renewalDate = readNullableString(input.context.renewal_date);
  const seats = readObject(input.context.seats);
  const underutilization = readObject(input.context.underutilization);
  const options = readRows(input.context.options);
  const alternatives = readRows(input.context.alternatives);
  const recommendedAction = actionFor(input.action, options);
  const resolvedOptions = options.length > 0 ? options : fallbackOptions(currentPrice, currency);
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);

  return {
    channel: "agent",
    action: {
      type: "subscription_management",
      kind: "agent_action",
      agent_kind: "subscription_management",
      subscription_id: subscriptionId,
      transaction_id: readNullableString(input.context.transaction_id),
      counterparty_id: readNullableString(input.context.counterparty_id),
      merchant,
      current_plan: currentPlan,
      renewal_date: renewalDate,
      currency,
      current_price: currentPrice,
      ...(seats !== null ? { seats } : {}),
      ...(underutilization !== null ? { underutilization } : {}),
      ...optionalRecordField("decision_context", input.context.decision_context),
      ...(alternatives.length > 0 ? { alternatives } : {}),
      options: resolvedOptions,
      recommended_action: recommendedAction,
      auto_approval_eligible: autoApprovalEligible(recommendedAction, input.context),
      decision_effect: decisionEffectFor(recommendedAction, subscriptionId, input.context),
      outreach_draft: outreachDraftFor(recommendedAction, merchant, seats, underutilization),
      narrative: narrativeFor(recommendedAction, merchant),
      summary: `Subscription management recommends ${recommendedAction}.`,
      risk_band: recommendedAction === "cancel" ? "elevated" : "standard",
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? "medium",
      agent_id: input.definition?.agent_key ?? "subscription_management",
      agent_role: input.definition?.agent_key ?? "subscription_management",
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: input.definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function actionFor(action: string, options: readonly Record<string, unknown>[]): string {
  if (["downgrade", "renegotiate", "cancel", "renew"].includes(action)) return action;
  const recommended = options.find((option) => option.recommended === true);
  return readString(recommended?.label, "renew");
}

function decisionEffectFor(
  action: string,
  subscriptionId: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  if (action === "downgrade") {
    return {
      kind: "request_vendor_seat_downgrade",
      subscription_id: subscriptionId,
      target_seats: readNumber(context.target_seats),
      vendor_api: readString(context.vendor_api_status, "unsupported"),
    };
  }
  if (action === "renegotiate") {
    return { kind: "draft_vendor_sales_outreach", subscription_id: subscriptionId };
  }
  if (action === "cancel") {
    return { kind: "mark_end_of_term_cancellation", subscription_id: subscriptionId };
  }
  return { kind: "accept_new_terms", subscription_id: subscriptionId };
}

function autoApprovalEligible(action: string, context: Record<string, unknown>): boolean {
  if (action !== "renew") return false;
  const annualPrice = readNumber(context.annual_price);
  const hasNoPriceChange =
    context.price_changed === false ||
    readNumber(context.price_change_percent) === 0 ||
    readNumber(context.price_delta) === 0;
  return annualPrice !== null && annualPrice < 500 && hasNoPriceChange;
}

function fallbackOptions(currentPrice: string, currency: string): Array<Record<string, unknown>> {
  return [
    {
      label: "renew",
      price: currentPrice,
      seats: 0,
      savings_vs_current: "0.00",
      recommended: true,
      currency,
    },
    {
      label: "cancel",
      price: "0.00",
      seats: 0,
      savings_vs_current: currentPrice,
      recommended: false,
      currency,
    },
  ];
}

function outreachDraftFor(
  action: string,
  merchant: string,
  seats: Record<string, unknown> | null,
  underutilization: Record<string, unknown> | null,
): string | null {
  if (action !== "downgrade" && action !== "renegotiate") {
    return null;
  }
  const licensed = readNumber(seats?.licensed);
  const active = readNumber(seats?.active_30d);
  const savings = readString(underutilization?.dollar_value);
  return (
    `Please review ${merchant} seat utilization. Licensed seats: ${licensed ?? "unknown"}. ` +
    `Active users in the last 30 days: ${active ?? "unknown"}. ` +
    `Potential savings: ${savings || "unknown"}.`
  );
}

function narrativeFor(action: string, merchant: string): string {
  return `Subscription management recommends ${action} for ${merchant}.`;
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

function readNullableString(value: unknown): string | null {
  const text = readString(value);
  return text.length > 0 ? text : null;
}

function optionalRecordField(key: string, value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { [key]: value }
    : {};
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
