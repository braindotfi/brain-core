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

/**
 * Payment actions. The money-moving actions (propose_payment, schedule_payment,
 * execute_payment) go through IPaymentIntentService.create, and therefore
 * Policy + the §6 pre-execution gate. The agent never settles directly;
 * "execute_payment" means "propose an intent the gate will execute".
 * request_approval is advisory and goes through IAgentService.propose.
 */
const FINANCIAL_ACTIONS = new Set(["propose_payment", "schedule_payment", "execute_payment"]);

type PayableDecision = "pay_now" | "defer";

export const paymentHandler: InternalAgentHandler = {
  agent_key: "payment",
  actions: ["propose_payment", "schedule_payment", "request_approval", "execute_payment"],
  build(input: HandlerInput): ProposedAction {
    if (FINANCIAL_ACTIONS.has(input.action)) {
      const c = input.context;
      const isOnchain = readString(c.rail) === "onchain";
      const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);
      return {
        channel: "payment_intent",
        intent: {
          action_type: isOnchain ? "onchain_transfer" : "ach_outbound",
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
          ...(typeof c.invoice_id === "string" ? { invoice_id: c.invoice_id } : {}),
        },
      };
    }
    return buildPaymentAdvisory(input);
  },
};

function buildPaymentAdvisory(input: HandlerInput): ProposedAction {
  const currency = requireCurrency(input.context, "currency");
  const sourceAccountId = requireStringField(input.context, "source_account_id");
  const payables = readPayables(input.context.payables, currency, input.context);
  const availableCash = optionalMoney(input.context.available_cash);
  const ranked = rankPayables(payables, availableCash, input.now ?? new Date());
  const top = ranked[0];
  if (top === undefined) {
    throw new Error("payment_required_payable_missing");
  }
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);

  return {
    channel: "agent",
    action: {
      type: "payment",
      kind: "agent_action",
      amount: top.amountText,
      currency,
      source_account_id: sourceAccountId,
      destination_counterparty_id: top.counterpartyId,
      due_date: top.dueDate,
      obligation_id: top.obligationId,
      recommended_action: "request_approval",
      recommended_payment_decision: top.decision,
      ranked_payables: ranked.map((item) => ({
        obligation_id: item.obligationId,
        counterparty_id: item.counterpartyId,
        counterparty_name: item.counterpartyName,
        amount: item.amountText,
        currency: item.currency,
        due_date: item.dueDate,
        discount_expires_at: item.discountExpiresAt,
        discount_amount: item.discountAmountText,
        decision: item.decision,
        priority_score: item.priorityScore.toFixed(2),
        reason: item.reason,
      })),
      narrative: narrativeFor(top, availableCash, currency),
      summary: `${top.decision} ${currency} ${top.amountText} for ${top.counterpartyName ?? top.counterpartyId}.`,
      risk_band: top.decision === "pay_now" ? "standard" : "watch",
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? null,
      agent_id: input.definition?.agent_key ?? "payment",
      agent_role: input.definition?.agent_key ?? "payment",
      evidence_refs: [
        ...evidenceRefsForAction(input.evidence.items),
        ...ranked.map((item) => ({ kind: "obligation", ref: item.obligationId })),
      ],
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: "propose",
    },
  };
}

interface Payable {
  readonly obligationId: string;
  readonly counterpartyId: string;
  readonly counterpartyName: string | null;
  readonly amount: number;
  readonly amountText: string;
  readonly currency: string;
  readonly dueDate: string;
  readonly discountExpiresAt: string | null;
  readonly discountAmount: number;
  readonly discountAmountText: string | null;
}

interface RankedPayable extends Payable {
  readonly decision: PayableDecision;
  readonly priorityScore: number;
  readonly reason: string;
}

function readPayables(raw: unknown, currency: string, context: Record<string, unknown>): Payable[] {
  const items = Array.isArray(raw)
    ? raw
    : [
        {
          obligation_id:
            optionalString(context.obligation_id) ?? optionalString(context.invoice_id),
          amount: context.amount,
          currency,
          due_date: context.due_date,
          counterparty_id:
            optionalString(context.counterparty_id) ??
            optionalString(context.destination_counterparty_id),
          counterparty_name: context.counterparty_name,
          discount_expires_at: context.discount_expires_at,
          discount_amount: context.discount_amount,
        },
      ];
  return items.map((item, index) => readPayable(item, currency, index));
}

function readPayable(raw: unknown, currency: string, index: number): Payable {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`payables[${index}] must be an object`);
  }
  const row = raw as Record<string, unknown>;
  const obligationId = requireAnyString(
    row,
    ["obligation_id", "invoice_id", "id"],
    `payables[${index}].obligation_id`,
  );
  const amount = requireMoney(row, "amount");
  const dueDate = requireAnyString(row, ["due_date", "date"], `payables[${index}].due_date`);
  const counterpartyId = requireAnyString(
    row,
    ["counterparty_id", "destination_counterparty_id"],
    `payables[${index}].counterparty_id`,
  );
  const rowCurrency = readString(row.currency, currency).toUpperCase();
  if (rowCurrency !== currency) {
    throw new Error(`payables[${index}].currency must match ${currency}`);
  }
  if (Number.isNaN(Date.parse(dueDate))) {
    throw new Error(`payables[${index}].due_date must be ISO date`);
  }
  const discountAmount = optionalMoney(row.discount_amount) ?? 0;
  return {
    obligationId,
    counterpartyId,
    counterpartyName: optionalString(row.counterparty_name),
    amount,
    amountText: formatMoney(amount),
    currency: rowCurrency,
    dueDate,
    discountExpiresAt: optionalString(row.discount_expires_at),
    discountAmount,
    discountAmountText: discountAmount > 0 ? formatMoney(discountAmount) : null,
  };
}

function rankPayables(
  payables: readonly Payable[],
  availableCash: number | null,
  now: Date,
): RankedPayable[] {
  return payables
    .map((payable) => scorePayable(payable, availableCash, now))
    .sort(
      (a, b) =>
        b.priorityScore - a.priorityScore ||
        Date.parse(a.dueDate) - Date.parse(b.dueDate) ||
        a.obligationId.localeCompare(b.obligationId),
    );
}

function scorePayable(payable: Payable, availableCash: number | null, now: Date): RankedPayable {
  const daysUntilDue = daysBetween(now, new Date(payable.dueDate));
  const discountWindow =
    payable.discountExpiresAt !== null &&
    Date.parse(payable.discountExpiresAt) >= startOfDay(now).getTime()
      ? Math.max(0, daysBetween(now, new Date(payable.discountExpiresAt)))
      : null;
  const dueScore = daysUntilDue <= 0 ? 60 : daysUntilDue <= 7 ? 45 : daysUntilDue <= 14 ? 25 : 5;
  const discountScore =
    discountWindow !== null && discountWindow <= 7
      ? Math.min(35, (payable.discountAmount / Math.max(payable.amount, 1)) * 1000)
      : 0;
  const cashPenalty = availableCash !== null && payable.amount > availableCash ? 30 : 0;
  const priorityScore = Math.max(0, dueScore + discountScore - cashPenalty);
  const decision: PayableDecision = priorityScore >= 40 ? "pay_now" : "defer";
  return {
    ...payable,
    decision,
    priorityScore,
    reason:
      decision === "pay_now"
        ? discountScore > 0
          ? "discount window or due date makes this payable urgent"
          : "due date makes this payable urgent"
        : "payable can be deferred under current priority rules",
  };
}

function narrativeFor(top: RankedPayable, availableCash: number | null, currency: string): string {
  const cash =
    availableCash === null ? "unknown cash" : `${currency} ${formatMoney(availableCash)}`;
  return `Ranked payable ${top.obligationId} as ${top.decision} against ${cash}. ${top.reason}.`;
}

function requireAnyString(
  row: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): string {
  for (const field of fields) {
    const value = readString(row[field]);
    if (value.length > 0) return value;
  }
  throw new Error(`${label} is required`);
}

function requireMoney(row: Record<string, unknown>, field: string): number {
  const value = optionalMoney(row[field]);
  if (value !== null && value >= 0) return value;
  throw new Error(`${field} is required`);
}

function optionalMoney(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

function optionalString(raw: unknown): string | null {
  const value = readString(raw);
  return value.length > 0 ? value : null;
}

function daysBetween(now: Date, target: Date): number {
  return Math.ceil((startOfDay(target).getTime() - startOfDay(now).getTime()) / 86_400_000);
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}
