import { brainError } from "@brain/shared";
import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  requireCurrency,
  requireStringField,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

type RecommendedAction = "hold" | "sweep_surplus" | "shortfall_alert";
type CashFlowKind = "receivable" | "payable";

interface CashFlow {
  readonly kind: CashFlowKind;
  readonly id: string;
  readonly amount: number;
  readonly amountText: string;
  readonly currency: string;
  readonly dueDate: string;
  readonly counterpartyId: string | null;
  readonly counterpartyName: string | null;
}

interface Thresholds {
  readonly shortfallFloor: number;
  readonly operatingMinimum: number;
  readonly sweepSurplusFloor: number;
}

interface Projection {
  readonly projectedNetPosition: Readonly<Record<"day_30" | "day_60" | "day_90", string>>;
  readonly projectedInflows: string;
  readonly projectedOutflows: string;
  readonly netPosition: string;
  readonly minProjectedBalance: string;
  readonly minProjectedBalanceDate: string;
  readonly shortfallDate: string | null;
  readonly recommendedAction: RecommendedAction;
}

/** Cash Forecast actions are advisory projections. They never move funds. */
export const cashForecastHandler: InternalAgentHandler = {
  agent_key: "cash_forecast",
  actions: ["generate_forecast", "recommend_action", "alert_shortfall", "create_runway_report"],
  build(input: HandlerInput): ProposedAction {
    return buildCashForecastProposal(input);
  },
};

function buildCashForecastProposal(input: HandlerInput): ProposedAction {
  const balanceId = requireStringField(input.context, "balance_id");
  const currentBalance = requireMoneyNumber(input.context, "current_balance");
  const currentBalanceText = formatMoney(currentBalance);
  const currency = requireCurrency(input.context, "currency");
  const receivables = readFlows(input.context.receivables, "receivable", currency);
  const payables = readFlows(input.context.payables, "payable", currency);
  const thresholds = readThresholds(input.context.thresholds);
  const now = input.now ?? new Date();
  const projection = projectCash({
    currentBalance,
    currency,
    receivables,
    payables,
    thresholds,
    now,
  });
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);
  const periodStart = dateOnly(now);
  const periodEnd = dateOnly(addDays(now, 90));

  return {
    channel: "agent",
    action: {
      type: "cash_forecast",
      kind: "agent_action",
      balance_id: balanceId,
      period_start: periodStart,
      period_end: periodEnd,
      current_balance: currentBalanceText,
      currency,
      projected_inflows: projection.projectedInflows,
      projected_outflows: projection.projectedOutflows,
      net_position: projection.netPosition,
      projected_net_position: projection.projectedNetPosition,
      min_projected_balance: projection.minProjectedBalance,
      min_projected_balance_date: projection.minProjectedBalanceDate,
      shortfall_date: projection.shortfallDate,
      recommended_action: projection.recommendedAction,
      confidence_band: confidenceBand(confidence),
      thresholds: {
        shortfall_floor: formatMoney(thresholds.shortfallFloor),
        operating_minimum: formatMoney(thresholds.operatingMinimum),
        sweep_surplus_floor: formatMoney(thresholds.sweepSurplusFloor),
      },
      receivables: receivables.map(wireFlow),
      payables: payables.map(wireFlow),
      narrative: narrativeFor({
        currentBalance: currentBalanceText,
        currency,
        projection,
        periodEnd,
      }),
      summary: `${currency} ${projection.netPosition} projected net position by ${periodEnd}.`,
      risk_band: projection.recommendedAction === "shortfall_alert" ? "high" : "standard",
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? null,
      agent_id: input.definition?.agent_key ?? "cash_forecast",
      agent_role: input.definition?.agent_key ?? "cash_forecast",
      evidence_refs: [
        ...evidenceRefsForAction(input.evidence.items),
        ...flowEvidence(receivables, payables),
      ],
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: input.definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function projectCash(input: {
  readonly currentBalance: number;
  readonly currency: string;
  readonly receivables: readonly CashFlow[];
  readonly payables: readonly CashFlow[];
  readonly thresholds: Thresholds;
  readonly now: Date;
}): Projection {
  const horizons = [
    ["day_30", addDays(input.now, 30)] as const,
    ["day_60", addDays(input.now, 60)] as const,
    ["day_90", addDays(input.now, 90)] as const,
  ];
  const flows = [...input.receivables, ...input.payables].sort(
    (a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate) || a.id.localeCompare(b.id),
  );
  const projectedNetPosition = Object.fromEntries(
    horizons.map(([key, horizon]) => [
      key,
      formatMoney(balanceAt(input.currentBalance, flows, horizon)),
    ]),
  ) as Projection["projectedNetPosition"];

  let running = input.currentBalance;
  let minBalance = input.currentBalance;
  let minDate = dateOnly(input.now);
  let shortfallDate: string | null =
    input.currentBalance < input.thresholds.shortfallFloor ? minDate : null;
  for (const flow of flows) {
    if (Date.parse(flow.dueDate) < startOfDay(input.now).getTime()) continue;
    if (Date.parse(flow.dueDate) > addDays(input.now, 90).getTime()) continue;
    running += flow.kind === "receivable" ? flow.amount : -flow.amount;
    if (running < minBalance) {
      minBalance = running;
      minDate = dateOnly(new Date(flow.dueDate));
    }
    if (shortfallDate === null && running < input.thresholds.shortfallFloor) {
      shortfallDate = dateOnly(new Date(flow.dueDate));
    }
  }
  const projectedInflows = sum(
    input.receivables.filter((flow) => withinHorizon(flow, input.now, 90)),
  );
  const projectedOutflows = sum(
    input.payables.filter((flow) => withinHorizon(flow, input.now, 90)),
  );
  const net90 = input.currentBalance + projectedInflows - projectedOutflows;
  const recommendedAction =
    shortfallDate !== null
      ? "shortfall_alert"
      : minBalance >= input.thresholds.operatingMinimum &&
          net90 >= input.thresholds.sweepSurplusFloor
        ? "sweep_surplus"
        : "hold";

  return {
    projectedNetPosition,
    projectedInflows: formatMoney(projectedInflows),
    projectedOutflows: formatMoney(projectedOutflows),
    netPosition: formatMoney(net90),
    minProjectedBalance: formatMoney(minBalance),
    minProjectedBalanceDate: minDate,
    shortfallDate,
    recommendedAction,
  };
}

function balanceAt(currentBalance: number, flows: readonly CashFlow[], horizon: Date): number {
  return flows.reduce((total, flow) => {
    if (Date.parse(flow.dueDate) > horizon.getTime()) return total;
    return total + (flow.kind === "receivable" ? flow.amount : -flow.amount);
  }, currentBalance);
}

function readFlows(raw: unknown, kind: CashFlowKind, currency: string): CashFlow[] {
  if (!Array.isArray(raw)) {
    throw brainError("request_body_invalid", `${kind}s are required`);
  }
  return raw.map((item, index) => readFlow(item, kind, currency, index));
}

function readFlow(raw: unknown, kind: CashFlowKind, currency: string, index: number): CashFlow {
  if (typeof raw !== "object" || raw === null) {
    throw brainError("request_body_invalid", `${kind}s[${index}] must be an object`);
  }
  const row = raw as Record<string, unknown>;
  const id =
    kind === "receivable"
      ? requireAnyString(row, ["invoice_id", "id"], `${kind}s[${index}].invoice_id`)
      : requireAnyString(row, ["obligation_id", "id"], `${kind}s[${index}].obligation_id`);
  const amount = requireMoneyNumber(row, "amount");
  const flowCurrency = readString(row.currency, currency).toUpperCase();
  if (flowCurrency !== currency) {
    throw brainError("request_body_invalid", `${kind}s[${index}].currency must match ${currency}`);
  }
  const dueDate = requireAnyString(row, ["due_date", "date"], `${kind}s[${index}].due_date`);
  if (Number.isNaN(Date.parse(dueDate))) {
    throw brainError("request_body_invalid", `${kind}s[${index}].due_date must be ISO date`);
  }
  return {
    kind,
    id,
    amount,
    amountText: formatMoney(amount),
    currency: flowCurrency,
    dueDate,
    counterpartyId: optionalString(row.counterparty_id),
    counterpartyName: optionalString(row.counterparty_name),
  };
}

function readThresholds(raw: unknown): Thresholds {
  const row = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const shortfallFloor = optionalMoney(row.shortfall_floor) ?? 0;
  return {
    shortfallFloor,
    operatingMinimum: optionalMoney(row.operating_minimum) ?? shortfallFloor,
    sweepSurplusFloor: optionalMoney(row.sweep_surplus_floor) ?? 50_000,
  };
}

function requireMoneyNumber(context: Record<string, unknown>, field: string): number {
  const raw = context[field];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (Number.isFinite(value) && value >= 0) return value;
  throw brainError("request_body_invalid", `${field} is required`);
}

function optionalMoney(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

function requireAnyString(
  row: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): string {
  for (const field of fields) {
    const value = optionalString(row[field]);
    if (value !== null) return value;
  }
  throw brainError("request_body_invalid", `${label} is required`);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function withinHorizon(flow: CashFlow, now: Date, days: number): boolean {
  const dueMs = Date.parse(flow.dueDate);
  return dueMs >= startOfDay(now).getTime() && dueMs <= addDays(now, days).getTime();
}

function flowEvidence(
  receivables: readonly CashFlow[],
  payables: readonly CashFlow[],
): Array<{ kind: string; ref: string }> {
  return [
    ...receivables.map((flow) => ({ kind: "invoice", ref: flow.id })),
    ...payables.map((flow) => ({ kind: "obligation", ref: flow.id })),
  ];
}

function wireFlow(flow: CashFlow): Record<string, unknown> {
  return {
    id: flow.id,
    amount: flow.amountText,
    currency: flow.currency,
    due_date: dateOnly(new Date(flow.dueDate)),
    counterparty_id: flow.counterpartyId,
    counterparty_name: flow.counterpartyName,
  };
}

function sum(flows: readonly CashFlow[]): number {
  return flows.reduce((total, flow) => total + flow.amount, 0);
}

function confidenceBand(confidence: number | null): "low" | "medium" | "high" | "unknown" {
  if (confidence === null) return "unknown";
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.65) return "medium";
  return "low";
}

function narrativeFor(input: {
  readonly currentBalance: string;
  readonly currency: string;
  readonly projection: Projection;
  readonly periodEnd: string;
}): string {
  if (input.projection.shortfallDate !== null) {
    return (
      `${input.currency} ${input.currentBalance} current balance is projected to fall below ` +
      `threshold on ${input.projection.shortfallDate}. Recommend shortfall_alert.`
    );
  }
  if (input.projection.recommendedAction === "sweep_surplus") {
    return (
      `${input.currency} ${input.currentBalance} current balance stays above operating minimum ` +
      `through ${input.periodEnd}. Recommend sweep_surplus.`
    );
  }
  return (
    `${input.currency} ${input.currentBalance} current balance remains non-negative through ` +
    `${input.periodEnd}. Recommend hold.`
  );
}

function addDays(base: Date, days: number): Date {
  return new Date(startOfDay(base).getTime() + days * 86_400_000);
}

function startOfDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}
