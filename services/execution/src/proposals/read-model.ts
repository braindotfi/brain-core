import { Buffer } from "node:buffer";
import {
  brainError,
  isBrainId,
  withTenantScope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import {
  canonicalEvidenceKind,
  evidenceKindFromRefPrefix,
  isEvidenceKindResolvable,
} from "../evidence/resolve.js";

export const PROPOSAL_TYPES = [
  "vendor_risk",
  "payment",
  "collections",
  "treasury",
  "cash_forecast",
  "dispute",
  "compliance",
  "revenue_intel",
  "reconciliation",
  "subscription",
  "fraud_anomaly",
  "personal_budget",
  "financial_health",
  "purchase_advisor",
  "tax_prep",
  "travel_finance",
  "bill_management",
  "debt_optimization",
  "savings",
] as const;

export type ProposalType = (typeof PROPOSAL_TYPES)[number];
export type ProposalRiskBand = "low" | "standard" | "elevated" | "high";
export type ProposalMode = "propose" | "notify_only";

export const AGENT_ROLE_TO_PROPOSAL_TYPE = {
  vendor_risk: "vendor_risk",
  payment: "payment",
  collections: "collections",
  treasury: "treasury",
  cash_forecast: "cash_forecast",
  dispute: "dispute",
  compliance: "compliance",
  revenue_intel: "revenue_intel",
  reconciliation: "reconciliation",
  subscription: "subscription",
  fraud_anomaly: "fraud_anomaly",
  personal_budget: "personal_budget",
  financial_health: "financial_health",
  purchase_advisor: "purchase_advisor",
  tax_prep: "tax_prep",
  travel_finance: "travel_finance",
  bill_management: "bill_management",
  debt_optimization: "debt_optimization",
  savings: "savings",
} as const satisfies Record<string, ProposalType>;

export const ACTION_TYPE_TO_PROPOSAL_TYPE = {
  flag_vendor_risk: "vendor_risk",
  require_approval: "vendor_risk",
  block_payment: "vendor_risk",
  flag_transaction: "fraud_anomaly",
  freeze_card: "fraud_anomaly",
  create_dispute_draft: "fraud_anomaly",
  flag_subscription: "subscription",
  recommend_cancel: "subscription",
  draft_vendor_email: "subscription",
  create_savings_report: "subscription",
  propose_match: "reconciliation",
  flag_discrepancy: "reconciliation",
  no_match: "reconciliation",
  gather_evidence: "dispute",
  draft_response: "dispute",
  create_dispute_packet: "dispute",
  recommend_follow_up: "revenue_intel",
  flag_churn_risk: "revenue_intel",
  identify_expansion_opportunity: "revenue_intel",
  create_revenue_summary: "revenue_intel",
  generate_forecast: "cash_forecast",
  alert_shortfall: "cash_forecast",
  create_runway_report: "cash_forecast",
  draft_followup: "collections",
  send_followup: "collections",
  propose_payment_plan: "collections",
  recommend_cash_sweep: "treasury",
  alert_low_balance: "treasury",
  create_liquidity_plan: "treasury",
  categorize_spending: "personal_budget",
  recommend_budget_adjustment: "personal_budget",
  create_budget_summary: "personal_budget",
  generate_health_score: "financial_health",
  create_monthly_summary: "financial_health",
  approve_recommendation: "purchase_advisor",
  warn: "purchase_advisor",
  recommend_delay: "purchase_advisor",
  suggest_budget_source: "purchase_advisor",
  tag_tax_item: "tax_prep",
  create_tax_summary: "tax_prep",
  request_missing_evidence: "tax_prep",
  export_tax_packet: "tax_prep",
  recommend_card: "travel_finance",
  flag_fee: "travel_finance",
  create_trip_spend_summary: "travel_finance",
  remind: "bill_management",
  alert_late_fee_risk: "bill_management",
  recommend_paydown: "debt_optimization",
  create_debt_plan: "debt_optimization",
  recommend_savings_transfer: "savings",
  update_goal_progress: "savings",
} as const satisfies Record<string, ProposalType>;

type DecisionId = "approve" | "reject" | "acknowledge" | "undo";

export interface ProposalDecisionAction {
  id: DecisionId;
  label: string;
  meaning: string;
}

export interface ProposalKeyFact {
  label: string;
  value: unknown;
}

export interface ProposalPolicySummary {
  decision: string | null;
  policy_id: string | null;
  policy_version: number | null;
  matched_rule_id: string | null;
  explanation: string | null;
  required_approvers: string[];
  trace: unknown;
}

export interface ProposalPresentation {
  headline: string;
  recommendation: string | null;
  key_facts: ProposalKeyFact[];
  confidence_band: string | null;
  policy: ProposalPolicySummary;
  consequences: {
    approve: string | null;
    reject: string | null;
    acknowledge: string | null;
  };
  actions: ProposalDecisionAction[];
  technical_detail: {
    "1_ingest": Record<string, unknown>;
    "2_extract": Record<string, unknown>;
    "3_classify": Record<string, unknown>;
    "4_score": Record<string, unknown>;
    "5_policy": ProposalPolicySummary;
    "6_propose": Record<string, unknown>;
  };
}

const PROPOSAL_TYPE_SET: ReadonlySet<string> = new Set(PROPOSAL_TYPES);
const RISK_BANDS = ["low", "standard", "elevated", "high"] as const;
const RISK_BAND_SET: ReadonlySet<string> = new Set(RISK_BANDS);
const STATUSES = [
  "proposed",
  "pending",
  "pending_approval",
  "awaiting_second_approval",
  "approved",
  "acknowledged",
  "reconciling",
  "paused",
  "dispatching",
  "rejected",
  "executed",
  "failed",
  "cancelled",
  "undone",
  "superseded",
  "unknown",
] as const;
const STATUS_SET: ReadonlySet<string> = new Set(STATUSES);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface ProposalAgentRef {
  id: string;
  kind: string;
  display_name: string;
}

export interface ProposalEvidenceRef {
  kind: string;
  ref: string;
  resolvable: boolean;
}

export interface ProposalReadItem {
  id: string;
  type: ProposalType;
  created_at: string;
  status: string;
  risk_band: ProposalRiskBand | null;
  confidence: number | null;
  mode: ProposalMode;
  narrative: string | null;
  evidence: ProposalEvidenceRef[];
  agent: ProposalAgentRef | null;
  payment_intent_id: string | null;
  action_type: string | null;
  stored_action_type: string | null;
  details: Record<string, unknown>;
  policy: ProposalPolicySummary;
  presentation: ProposalPresentation;
  available_decisions: ProposalDecisionAction[];
}

export interface ListProposalsInput {
  type?: ProposalType;
  status?: string;
  risk_band?: ProposalRiskBand;
  min_confidence?: number;
  limit?: number;
  cursor?: string;
}

export interface ListProposalsResult {
  proposals: ProposalReadItem[];
  next_cursor: string | null;
}

interface ProposalCursor {
  created_at: string;
  id: string;
}

interface RawProposalRow {
  id: string;
  source_kind: "payment_intent" | "proposal";
  type: ProposalType | null;
  created_at: Date | string;
  status: string;
  risk_band: ProposalRiskBand | null;
  confidence: number | string | null;
  mode: ProposalMode;
  narrative: string | null;
  action: Record<string, unknown> | null;
  evidence_ids: string[] | null;
  agent_id: string | null;
  agent_kind: string | null;
  agent_display_name: string | null;
  payment_intent_id: string | null;
  action_type: string | null;
  policy_decision: string | null;
  policy_version: number | null;
  policy_trace: unknown;
  required_approvers: string[] | null;
  policy_decision_id: string | null;
  policy_id: string | null;
  matched_rule_id: string | null;
}

interface StoredEvidenceRef {
  kind: string;
  ref: string;
}

export function parseListProposalsQuery(query: {
  type?: string;
  status?: string;
  risk_band?: string;
  min_confidence?: string;
  limit?: string;
  cursor?: string;
}): ListProposalsInput {
  const result: ListProposalsInput = {};
  if (query.type !== undefined) {
    if (!PROPOSAL_TYPE_SET.has(query.type)) {
      throw brainError("request_params_invalid", `unknown proposal type: ${query.type}`);
    }
    result.type = query.type as ProposalType;
  }
  if (query.status !== undefined) {
    if (!STATUS_SET.has(query.status)) {
      throw brainError("request_params_invalid", `unknown proposal status: ${query.status}`);
    }
    result.status = query.status;
  }
  if (query.risk_band !== undefined) {
    if (!RISK_BAND_SET.has(query.risk_band)) {
      throw brainError("request_params_invalid", `unknown risk_band: ${query.risk_band}`);
    }
    result.risk_band = query.risk_band as ProposalRiskBand;
  }
  if (query.min_confidence !== undefined) {
    const parsed = Number(query.min_confidence);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw brainError("request_params_invalid", "min_confidence must be between 0 and 1");
    }
    result.min_confidence = parsed;
  }
  if (query.limit !== undefined) {
    const parsed = Number.parseInt(query.limit, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw brainError("request_params_invalid", "limit must be a positive integer");
    }
    result.limit = Math.min(parsed, MAX_LIMIT);
  }
  if (query.cursor !== undefined) {
    decodeCursor(query.cursor);
    result.cursor = query.cursor;
  }
  return result;
}

export async function listProposals(
  pool: Pool,
  ctx: ServiceCallContext,
  input: ListProposalsInput,
): Promise<ListProposalsResult> {
  const limit = clampLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;
  const rows = await withTenantScope(pool, ctx.tenantId, (client) =>
    queryProposalRows(client, input, limit + 1, cursor),
  );
  const visibleRows = rows.slice(0, limit);
  const proposals = visibleRows.map((row) => serializeProposalRow(row));
  const last = visibleRows.at(-1);
  return {
    proposals,
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ created_at: isoDate(last.created_at), id: last.id })
        : null,
  };
}

export async function getProposal(
  pool: Pool,
  ctx: ServiceCallContext,
  id: string,
): Promise<ProposalReadItem | null> {
  if (!isBrainId(id, "pi") && !isBrainId(id, "prop")) {
    throw brainError("request_params_invalid", "malformed proposal id");
  }
  return withTenantScope(pool, ctx.tenantId, async (client) => {
    const rows = await queryProposalRows(client, {}, 1, null, id);
    const row = rows[0];
    if (row === undefined) return null;
    return serializeProposalRow(row);
  });
}

export async function getPaymentIntentAgent(
  pool: Pool,
  ctx: ServiceCallContext,
  paymentIntentId: string,
): Promise<ProposalAgentRef | null> {
  return withTenantScope(pool, ctx.tenantId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      kind: string;
      display_name: string;
    }>(
      `SELECT a.id, a.kind, a.display_name
         FROM ledger_payment_intents pi
         JOIN agents a ON a.id = pi.created_by_agent_id AND a.tenant_id = pi.owner_id
        WHERE pi.id = $1
        LIMIT 1`,
      [paymentIntentId],
    );
    return rows[0] ?? null;
  });
}

async function queryProposalRows(
  client: TenantScopedClient,
  input: ListProposalsInput,
  limit: number,
  cursor: ProposalCursor | null,
  id?: string,
): Promise<RawProposalRow[]> {
  const values: unknown[] = [PROPOSAL_TYPES];
  const filters: string[] = ["type IS NOT NULL"];
  if (id !== undefined) {
    values.push(id);
    filters.push(`id = $${values.length}`);
  }
  if (input.type !== undefined) {
    values.push(input.type);
    filters.push(`type = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    filters.push(`status = $${values.length}`);
  }
  if (input.risk_band !== undefined) {
    values.push(input.risk_band);
    filters.push(`risk_band = $${values.length}`);
  }
  if (input.min_confidence !== undefined) {
    values.push(input.min_confidence);
    filters.push(`confidence IS NOT NULL AND confidence >= $${values.length}`);
  }
  if (cursor !== null) {
    values.push(cursor.created_at, cursor.id);
    filters.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  values.push(limit);
  const limitIndex = values.length;
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const proposalTypeSql = publicProposalTypeSqlExpression({
    actionType: "p.action->>'type'",
    actionAgentRole: "p.action->>'agent_role'",
    actionAgentKind: "p.action->>'agent_kind'",
    actionAgentId: "p.action->>'agent_id'",
    actionKind: "p.action->>'kind'",
    joinedAgentRole: "a.role",
  });
  const paymentIntentTypeSql = publicProposalTypeSqlExpression({
    actionType: "pi.action_type",
    joinedAgentRole: "a.role",
  });

  const { rows } = await client.query<RawProposalRow>(
    `WITH unified AS (
       SELECT
         pi.id,
         'payment_intent'::text AS source_kind,
         COALESCE(${paymentIntentTypeSql}, 'payment') AS type,
         pi.created_at,
         pi.status,
         NULL::text AS risk_band,
         pi.confidence::float8 AS confidence,
         'propose'::text AS mode,
         NULL::text AS narrative,
         jsonb_build_object(
           'type', 'payment',
           'kind', 'payment_intent',
           'payment_intent_id', pi.id,
           'action_type', pi.action_type,
           'source_account_id', pi.source_account_id,
           'destination_counterparty_id', pi.destination_counterparty_id,
           'amount', pi.amount::text,
           'currency', pi.currency,
           'obligation_id', pi.obligation_id,
           'invoice_id', pi.invoice_id,
           'policy_decision_id', pi.policy_decision_id,
           'source_ids', pi.source_ids,
           'evidence_ids', pi.evidence_ids,
           'evidence_score', pi.evidence_score,
           'risk_level', pi.risk_level
         ) AS action,
         pi.evidence_ids,
         a.id AS agent_id,
         a.kind AS agent_kind,
         a.display_name AS agent_display_name,
         pi.id AS payment_intent_id,
         pi.action_type,
         pd.outcome AS policy_decision,
         pd.policy_version AS policy_version,
         pd.trace AS policy_trace,
         COALESCE(pd.required_approvers, ARRAY[]::text[]) AS required_approvers,
         pi.policy_decision_id,
         pd.policy_id,
         pd.matched_rule_id
       FROM ledger_payment_intents pi
       LEFT JOIN agents a ON a.id = pi.created_by_agent_id AND a.tenant_id = pi.owner_id
       LEFT JOIN policy_decisions pd ON pd.id = pi.policy_decision_id AND pd.tenant_id = pi.owner_id
       WHERE pi.created_by_agent_id IS NOT NULL
         AND pi.owner_id = current_setting('app.tenant_id', true)
       UNION ALL
       SELECT
         p.id,
         'proposal'::text AS source_kind,
         ${proposalTypeSql} AS type,
         p.created_at,
         p.status,
         CASE WHEN p.action->>'risk_band' IN ('low','standard','elevated','high')
           THEN p.action->>'risk_band'
           ELSE NULL
         END AS risk_band,
         CASE WHEN p.action->>'confidence' ~ '^(0(\\.\\d+)?|1(\\.0+)?)$'
           THEN (p.action->>'confidence')::float8
           ELSE NULL
         END AS confidence,
         CASE WHEN p.action->>'mode' = 'notify_only' THEN 'notify_only' ELSE 'propose' END AS mode,
         COALESCE(p.action->>'narrative', p.action->>'summary', p.action->>'description') AS narrative,
         p.action,
         ARRAY[]::text[] AS evidence_ids,
         a.id AS agent_id,
         a.kind AS agent_kind,
         a.display_name AS agent_display_name,
         NULL::text AS payment_intent_id,
         NULL::text AS action_type,
         p.policy_decision,
         p.policy_version,
         p.policy_trace,
         p.required_approvers,
         CASE WHEN p.action->>'policy_decision_id' ~ '^pd_' THEN p.action->>'policy_decision_id' ELSE NULL END AS policy_decision_id,
         CASE WHEN p.action->>'policy_id' IS NOT NULL THEN p.action->>'policy_id' ELSE NULL END AS policy_id,
         CASE WHEN p.action->>'matched_rule_id' IS NOT NULL THEN p.action->>'matched_rule_id' ELSE NULL END AS matched_rule_id
       FROM proposals p
       LEFT JOIN agents a ON a.id = p.proposing_agent AND a.tenant_id = p.tenant_id
       WHERE p.tenant_id = current_setting('app.tenant_id', true)
     )
     SELECT * FROM unified
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${limitIndex}`,
    values,
  );
  return rows;
}

function serializeProposalRow(row: RawProposalRow): ProposalReadItem {
  if (row.type === null || !PROPOSAL_TYPE_SET.has(row.type)) {
    throw new Error(`proposal ${row.id} did not resolve to a customer-facing type`);
  }
  const proposalType = row.type;
  const candidateEvidenceRefs =
    row.source_kind === "payment_intent"
      ? evidenceRefsFromPaymentIntentIds(row.evidence_ids ?? [])
      : evidenceRefsFromAction(row.action ?? {});
  const evidence = resolvableEvidenceRefs(candidateEvidenceRefs);
  const action = row.action ?? {};
  const storedActionType =
    row.source_kind === "payment_intent" ? row.action_type : firstString(action, ["type"]);
  const policy = policySummary(row, action);
  const details = proposalDetails(row);
  const availableDecisions = decisionsForProposal(proposalType, row.mode, row.status);
  const presentation = proposalPresentation({
    row,
    proposalType,
    action,
    evidence,
    policy,
    details,
    storedActionType,
    availableDecisions,
  });
  return {
    id: row.id,
    type: proposalType,
    created_at: isoDate(row.created_at),
    status: row.status,
    risk_band: row.risk_band !== null && RISK_BAND_SET.has(row.risk_band) ? row.risk_band : null,
    confidence: normalizeConfidence(row.confidence),
    mode: row.mode,
    narrative: row.narrative,
    evidence,
    agent:
      row.agent_id !== null && row.agent_kind !== null && row.agent_display_name !== null
        ? { id: row.agent_id, kind: row.agent_kind, display_name: row.agent_display_name }
        : null,
    payment_intent_id: row.payment_intent_id,
    action_type: row.action_type,
    stored_action_type: storedActionType,
    details,
    policy,
    presentation,
    available_decisions: availableDecisions,
  };
}

export function resolvePublicProposalType(input: {
  actionType?: string | null;
  actionAgentRole?: string | null;
  actionAgentKind?: string | null;
  actionAgentId?: string | null;
  actionKind?: string | null;
  joinedAgentRole?: string | null;
}): ProposalType | null {
  const direct = asProposalType(input.actionType);
  if (direct !== null) return direct;

  for (const candidate of [
    input.actionAgentRole,
    input.actionAgentKind,
    input.actionAgentId,
    input.joinedAgentRole,
    input.actionKind,
  ]) {
    const byRole = proposalTypeFromAgentRole(candidate);
    if (byRole !== null) return byRole;
  }

  if (input.actionType !== undefined && input.actionType !== null) {
    return mappedActionType(input.actionType);
  }
  return null;
}

function publicProposalTypeSqlExpression(input: {
  actionType: string;
  actionAgentRole?: string;
  actionAgentKind?: string;
  actionAgentId?: string;
  actionKind?: string;
  joinedAgentRole?: string;
}): string {
  const roleExpressions = [
    input.actionAgentRole,
    input.actionAgentKind,
    input.actionAgentId,
    input.joinedAgentRole,
    input.actionKind,
  ].filter((value): value is string => value !== undefined);
  const directCase = `CASE WHEN ${input.actionType} = ANY($1::text[]) THEN ${input.actionType} ELSE NULL END`;
  const roleCases = roleExpressions.map((expression) =>
    sqlCaseFromMap(expression, AGENT_ROLE_TO_PROPOSAL_TYPE),
  );
  const actionCase = sqlCaseFromMap(input.actionType, ACTION_TYPE_TO_PROPOSAL_TYPE);
  return `COALESCE(${[directCase, ...roleCases, actionCase].join(", ")})`;
}

function sqlCaseFromMap(
  expression: string,
  mapping: Readonly<Record<string, ProposalType>>,
): string {
  const clauses = Object.entries(mapping).map(
    ([stored, proposalType]) =>
      `WHEN ${expression} = '${sqlLiteral(stored)}' THEN '${sqlLiteral(proposalType)}'`,
  );
  return `CASE ${clauses.join(" ")} ELSE NULL END`;
}

function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function asProposalType(value: string | null | undefined): ProposalType | null {
  return value !== null && value !== undefined && PROPOSAL_TYPE_SET.has(value)
    ? (value as ProposalType)
    : null;
}

function proposalTypeFromAgentRole(value: string | null | undefined): ProposalType | null {
  if (value === null || value === undefined) return null;
  return hasOwn(AGENT_ROLE_TO_PROPOSAL_TYPE, value) ? AGENT_ROLE_TO_PROPOSAL_TYPE[value] : null;
}

function mappedActionType(value: string): ProposalType | null {
  return hasOwn(ACTION_TYPE_TO_PROPOSAL_TYPE, value) ? ACTION_TYPE_TO_PROPOSAL_TYPE[value] : null;
}

function hasOwn<T extends Record<string, unknown>>(
  obj: T,
  key: string,
): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function proposalDetails(row: RawProposalRow): Record<string, unknown> {
  return row.action !== null ? { ...row.action } : {};
}

function policySummary(
  row: RawProposalRow,
  action: Record<string, unknown>,
): ProposalPolicySummary {
  const trace = row.policy_trace ?? action["policy_trace"] ?? null;
  return {
    decision: row.policy_decision ?? firstString(action, ["policy_decision", "policy_outcome"]),
    policy_id: row.policy_id ?? firstString(action, ["policy_id", "policy"]),
    policy_version: row.policy_version,
    matched_rule_id: row.matched_rule_id ?? firstString(action, ["matched_rule_id", "rule_id"]),
    explanation:
      policyExplanation(trace) ?? firstString(action, ["policy_explanation", "explanation"]),
    required_approvers: row.required_approvers ?? [],
    trace,
  };
}

function policyExplanation(trace: unknown): string | null {
  if (typeof trace === "string" && trace.trim().length > 0) return trace;
  if (Array.isArray(trace)) {
    const parts = trace
      .map((item) => (typeof item === "string" ? item : null))
      .filter((item): item is string => item !== null && item.length > 0);
    return parts.length > 0 ? parts.join("; ") : null;
  }
  if (trace !== null && typeof trace === "object") {
    const record = trace as Record<string, unknown>;
    return firstString(record, ["explanation", "reason", "summary"]);
  }
  return null;
}

function proposalPresentation(input: {
  row: RawProposalRow;
  proposalType: ProposalType;
  action: Record<string, unknown>;
  evidence: ProposalEvidenceRef[];
  policy: ProposalPolicySummary;
  details: Record<string, unknown>;
  storedActionType: string | null;
  availableDecisions: ProposalDecisionAction[];
}): ProposalPresentation {
  const recommendation = firstString(input.action, [
    "recommended_action",
    "recommendation",
    "recommended_payment_decision",
  ]);
  const headline =
    firstString(input.action, ["headline", "summary", "narrative", "description"]) ??
    defaultHeadline(input.proposalType, recommendation ?? input.storedActionType);
  const confidence = normalizeConfidence(input.row.confidence);
  const riskBand =
    input.row.risk_band !== null && RISK_BAND_SET.has(input.row.risk_band)
      ? input.row.risk_band
      : null;
  const consequenceSet = consequencesFor(input.proposalType, input.row.mode);
  return {
    headline,
    recommendation,
    key_facts: keyFactsFor(input.proposalType, input.details),
    confidence_band: firstString(input.action, ["confidence_band"]) ?? confidenceBand(confidence),
    policy: input.policy,
    consequences: {
      approve:
        firstString(input.action, ["approve_consequence", "clear_consequence"]) ??
        consequenceSet.approve,
      reject:
        firstString(input.action, ["reject_consequence", "hold_consequence"]) ??
        consequenceSet.reject,
      acknowledge:
        firstString(input.action, ["acknowledge_consequence"]) ?? consequenceSet.acknowledge,
    },
    actions: input.availableDecisions,
    technical_detail: {
      "1_ingest": {
        evidence_refs: input.evidence,
      },
      "2_extract": input.details,
      "3_classify": {
        public_type: input.proposalType,
        stored_action_type: input.storedActionType,
        source_kind: input.row.source_kind,
        agent_kind: input.row.agent_kind,
      },
      "4_score": {
        risk_band: riskBand,
        confidence,
        confidence_band:
          firstString(input.action, ["confidence_band"]) ?? confidenceBand(confidence),
        evidence_score: input.details["evidence_score"] ?? null,
        risk_level: input.details["risk_level"] ?? null,
        risk_score: input.details["risk_score"] ?? input.details["anomaly_score"] ?? null,
        ranked_signals: input.details["ranked_signals"] ?? null,
      },
      "5_policy": input.policy,
      "6_propose": {
        status: input.row.status,
        mode: input.row.mode,
        recommendation,
        available_decisions: input.availableDecisions.map((decision) => decision.id),
      },
    },
  };
}

function defaultHeadline(type: ProposalType, recommendation: string | null): string {
  const label = type.replaceAll("_", " ");
  return recommendation !== null
    ? `${label}: ${recommendation.replaceAll("_", " ")}`
    : `${label} proposal`;
}

function keyFactsFor(type: ProposalType, details: Record<string, unknown>): ProposalKeyFact[] {
  const keys = KEY_FACT_KEYS[type] ?? [];
  return keys
    .map((key) => ({ label: labelForKey(key), value: details[key] }))
    .filter((fact) => fact.value !== undefined && fact.value !== null && fact.value !== "");
}

const KEY_FACT_KEYS: Readonly<Record<ProposalType, readonly string[]>> = {
  vendor_risk: [
    "vendor_name",
    "vendor_id",
    "identity_status",
    "identity_resolved",
    "payment_destination_id",
    "previous_value_hash",
    "new_value_hash",
    "changed_field",
    "risk_score",
    "recommended_action",
  ],
  payment: [
    "amount",
    "currency",
    "source_account_id",
    "destination_counterparty_id",
    "obligation_id",
    "invoice_id",
    "due_date",
  ],
  collections: [
    "counterparty_name",
    "invoice_number",
    "amount_due",
    "currency",
    "due_date",
    "days_overdue",
    "recommended_action",
  ],
  treasury: [
    "available_cash",
    "currency",
    "recommended_transfer",
    "operating_minimum",
    "liquidity_risk",
    "recommended_action",
  ],
  cash_forecast: [
    "current_balance",
    "currency",
    "projected_inflows",
    "projected_outflows",
    "net_position",
    "shortfall_date",
  ],
  dispute: ["dispute_id", "transaction_id", "amount", "currency", "deadline", "recommended_action"],
  compliance: [
    "finding_type",
    "severity",
    "rule_id",
    "policy_decision_id",
    "audit_event_id",
    "recommended_remediation",
  ],
  revenue_intel: [
    "period",
    "segment",
    "revenue_delta",
    "revenue_delta_percent",
    "at_risk_customer_count",
    "upcoming_renewal_count",
  ],
  reconciliation: [
    "transaction_id",
    "amount",
    "currency",
    "match_type",
    "right_entity_type",
    "right_entity_id",
    "confidence_score",
  ],
  subscription: [
    "merchant",
    "recurring_amount",
    "currency",
    "billing_frequency",
    "next_expected_date",
    "recommended_action",
  ],
  fraud_anomaly: [
    "transaction_id",
    "counterparty_name",
    "amount",
    "currency",
    "anomaly_type",
    "anomaly_score",
    "recommended_action",
  ],
  personal_budget: ["recommended_action", "category", "amount", "currency", "period", "budget_id"],
  financial_health: ["recommended_action", "health_score", "period", "metric", "trend"],
  purchase_advisor: [
    "recommended_action",
    "merchant",
    "amount",
    "currency",
    "purchase_category",
    "budget_id",
  ],
  tax_prep: ["recommended_action", "tax_year", "tax_category", "document_id", "amount", "currency"],
  travel_finance: ["recommended_action", "trip_id", "merchant", "amount", "currency", "fee_type"],
  bill_management: [
    "recommended_action",
    "invoice_id",
    "obligation_id",
    "amount",
    "currency",
    "due_date",
  ],
  debt_optimization: [
    "recommended_action",
    "debt_account_id",
    "amount",
    "currency",
    "interest_rate",
    "priority",
  ],
  savings: ["recommended_action", "goal_id", "amount", "currency", "target_account_id", "progress"],
};

function labelForKey(key: string): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function confidenceBand(confidence: number | null): string | null {
  if (confidence === null) return null;
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

export function decisionsForProposal(
  type: ProposalType,
  mode: ProposalMode,
  status: string,
): ProposalDecisionAction[] {
  if (status === "superseded") return [];
  if (type === "compliance" || mode === "notify_only") {
    return [
      {
        id: "acknowledge",
        label: "Acknowledge",
        meaning: "Record review of the informational finding without unblocking a blocked action.",
      },
    ];
  }
  switch (type) {
    case "vendor_risk":
      return [
        { id: "approve", label: "Clear vendor", meaning: "Allow the proposed vendor action." },
        { id: "reject", label: "Hold vendor", meaning: "Keep the vendor action blocked." },
      ];
    case "fraud_anomaly":
      return [
        { id: "approve", label: "Mark reviewed", meaning: "Accept the flagged transaction." },
        { id: "reject", label: "Hold transaction", meaning: "Keep the transaction blocked." },
      ];
    case "reconciliation":
      return [
        { id: "approve", label: "Accept match", meaning: "Accept the proposed match." },
        { id: "reject", label: "Reject match", meaning: "Leave the records unreconciled." },
      ];
    case "dispute":
      return [
        { id: "approve", label: "Proceed", meaning: "Proceed with the dispute recommendation." },
        { id: "reject", label: "Dismiss", meaning: "Dismiss the dispute recommendation." },
      ];
    default:
      return [
        { id: "approve", label: "Approve", meaning: "Approve the proposed action." },
        { id: "reject", label: "Reject", meaning: "Reject the proposed action." },
      ];
  }
}

function consequencesFor(
  type: ProposalType,
  mode: ProposalMode,
): { approve: string | null; reject: string | null; acknowledge: string | null } {
  if (type === "compliance" || mode === "notify_only") {
    return {
      approve: null,
      reject: null,
      acknowledge:
        "The finding is marked acknowledged. Any original blocked action remains blocked.",
    };
  }
  switch (type) {
    case "vendor_risk":
      return {
        approve: "The vendor risk hold is cleared for this proposal.",
        reject: "The vendor action remains held for follow-up verification.",
        acknowledge: null,
      };
    case "fraud_anomaly":
      return {
        approve: "The flagged transaction is marked reviewed for this proposal.",
        reject: "The transaction stays held for investigation.",
        acknowledge: null,
      };
    case "reconciliation":
      return {
        approve: "The proposed reconciliation match can be accepted by downstream workflow.",
        reject: "The transaction and candidate stay unmatched.",
        acknowledge: null,
      };
    default:
      return {
        approve: "The proposed agent action is approved for the existing execution rails.",
        reject: "The proposed agent action is rejected and will not execute.",
        acknowledge: null,
      };
  }
}

function evidenceRefsFromAction(action: Record<string, unknown>): StoredEvidenceRef[] {
  const refs: StoredEvidenceRef[] = [];
  addEvidenceValue(refs, action["evidence_ids"]);
  addEvidenceValue(refs, action["evidence"]);
  addEvidenceValue(refs, action["evidence_refs"]);
  addEvidenceValue(refs, action["wiki_entity_ids"]);
  return refs;
}

function evidenceRefsFromPaymentIntentIds(ids: string[]): StoredEvidenceRef[] {
  return ids.map((ref) => ({ kind: kindFromPaymentIntentEvidenceRef(ref), ref }));
}

function addEvidenceValue(refs: StoredEvidenceRef[], value: unknown): void {
  if (typeof value === "string") {
    refs.push({ kind: evidenceKindFromRefPrefix(value) ?? "unknown", ref: value });
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string") {
      refs.push({ kind: evidenceKindFromRefPrefix(item) ?? "unknown", ref: item });
    } else if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const ref = firstString(record, ["ref", "id", "entity_id", "wiki_entity_id"]);
      if (ref === null) continue;
      refs.push({
        kind: evidenceKindFromRecord(record, ref),
        ref,
      });
    }
  }
}

function resolvableEvidenceRefs(candidates: StoredEvidenceRef[]): ProposalEvidenceRef[] {
  return candidates
    .filter((item) => item.ref.length > 0)
    .map((item) => {
      const kind = canonicalEvidenceKind(item.kind, item.ref);
      return {
        kind,
        ref: item.ref,
        resolvable: isEvidenceKindResolvable(kind),
      };
    });
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function evidenceKindFromRecord(record: Record<string, unknown>, ref: string): string {
  const byPrefix = evidenceKindFromRefPrefix(ref);
  if (byPrefix !== null) return byPrefix;
  const kind = record["kind"];
  if (typeof kind === "string" && kind.trim().length > 0) return kind.trim();
  if (typeof record["wiki_entity_id"] === "string") return "wiki_entity";
  return bestEffortKindByRef(ref);
}

function kindFromPaymentIntentEvidenceRef(ref: string): string {
  if (ref.startsWith("doc_")) return "document";
  return evidenceKindFromRefPrefix(ref) ?? bestEffortKindByRef(ref);
}

function bestEffortKindByRef(ref: string): string {
  const prefix = ref.split("_", 1)[0];
  switch (prefix) {
    case "acct":
      return "account";
    case "agent":
      return "agent";
    case "cp":
      return "counterparty";
    case "doc":
      return "document";
    case "ent":
      return "wiki_entity";
    case "inv":
      return "invoice";
    case "obl":
      return "obligation";
    case "pd":
      return "policy_decision";
    case "pi":
      return "payment_intent";
    case "pol":
      return "policy";
    case "prs":
      return "raw_parsed";
    case "raw":
      return "raw_artifact";
    case "tx":
      return "transaction";
    default:
      return "unknown";
  }
}

function normalizeConfidence(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function encodeCursor(cursor: ProposalCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): ProposalCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ProposalCursor>;
    if (
      typeof parsed.created_at !== "string" ||
      Number.isNaN(new Date(parsed.created_at).getTime()) ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("bad cursor");
    }
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    throw brainError("request_params_invalid", "cursor is invalid");
  }
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
