/**
 * Internal-agent handler contract.
 *
 * A handler builds a proposal for a triggered action. It NEVER executes:
 *   - non-financial proposals go through IAgentService.propose
 *   - financial proposals go through IPaymentIntentService.create, which
 *     runs Policy and the §6 pre-execution gate
 *
 * `build` is pure (no I/O): the router/worker gathers evidence and context
 * up front, then the handler shapes the proposal payload.
 */

import type {
  CreatePaymentIntentInput,
  IAgentService,
  IPaymentIntentService,
  ServiceCallContext,
} from "@brain/shared";
import { brainError } from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import type { EvidenceBundle, EvidenceRef } from "./evidence.js";

export type ProposedAction =
  | {
      readonly channel: "agent";
      readonly action: Record<string, unknown>;
      /** Internal handler signal: record an existing notify-only run, not a proposal. */
      readonly informational?: boolean;
    }
  | { readonly channel: "payment_intent"; readonly intent: CreatePaymentIntentInput };

export interface HandlerInput {
  readonly action: string;
  readonly context: Record<string, unknown>;
  readonly evidence: EvidenceBundle;
  readonly definition?: InternalAgentDefinition;
  readonly confidence?: number;
  readonly now?: Date;
}

export interface InternalAgentHandler {
  readonly agent_key: string;
  readonly actions: readonly string[];
  build(input: HandlerInput): ProposedAction;
}

export interface ProposeDeps {
  readonly agents: IAgentService;
  readonly paymentIntents: IPaymentIntentService;
}

export interface ProposeResult {
  readonly id: string;
  readonly status: string;
  readonly policy_decision_id: string | null;
}

/** Dispatch a built proposal through the existing propose path. */
export async function proposeAction(
  proposed: ProposedAction,
  ctx: ServiceCallContext,
  agentId: string,
  deps: ProposeDeps,
): Promise<ProposeResult> {
  if (proposed.channel === "agent") {
    const r = await deps.agents.propose(ctx, agentId, { action: proposed.action });
    return { id: r.id, status: r.status, policy_decision_id: r.policy_decision_id };
  }
  const pi = await deps.paymentIntents.create(ctx, proposed.intent);
  return { id: pi.id, status: pi.status, policy_decision_id: pi.policy_decision_id };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function requireStringField(context: Record<string, unknown>, field: string): string {
  const value = context[field];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw brainError("request_body_invalid", `${field} is required`);
}

export function requireDecimalAmount(context: Record<string, unknown>, field: string): string {
  const value = requireStringField(context, field);
  if (!/^\d+(\.\d+)?$/.test(value) || value === "0") {
    throw brainError("request_body_invalid", `${field} must be a positive decimal string`);
  }
  return value;
}

export function requireCurrency(context: Record<string, unknown>, field: string): string {
  const value = requireStringField(context, field).toUpperCase();
  if (!/^[A-Z]{3,6}$/.test(value)) {
    throw brainError("request_body_invalid", `${field} must be a currency code`);
  }
  return value;
}

/** Shared helper: shape a non-financial agent proposal from context + evidence. */
export function agentProposal(input: HandlerInput): ProposedAction {
  const definition = input.definition;
  const agentKey = definition?.agent_key ?? null;
  const context = compactContext(input.context);
  const subject = primarySubject(input.context);
  return {
    channel: "agent",
    action: {
      type: input.action,
      kind: "agent_action",
      agent_kind: agentKey,
      domain: agentKey,
      subject,
      subject_refs: subjectRefs(input.context),
      context,
      recommended_action: input.action,
      invoice_id: str(input.context.invoice_id) || null,
      counterparty_id: str(input.context.counterparty_id) || null,
      narrative: narrativeForGenericProposal(input.action, agentKey, subject),
      summary: summaryForGenericProposal(input.action, agentKey, subject),
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      confidence: policyConfidenceForEvidence(input.evidence, input.confidence),
      evidence_score: validUnit(input.evidence.evidence_score)
        ? input.evidence.evidence_score
        : null,
      risk_level: definition?.risk_level ?? null,
      agent_id: agentKey,
      agent_role: agentKey,
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function compactContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined && value !== null),
  );
}

function primarySubject(context: Record<string, unknown>): { kind: string; ref: string } | null {
  for (const [field, kind] of SUBJECT_FIELDS) {
    const ref = str(context[field]);
    if (ref.length > 0) return { kind, ref };
  }
  return null;
}

function subjectRefs(context: Record<string, unknown>): Array<{ kind: string; ref: string }> {
  return SUBJECT_FIELDS.map(([field, kind]) => {
    const ref = str(context[field]);
    return ref.length > 0 ? { kind, ref } : null;
  }).filter((item): item is { kind: string; ref: string } => item !== null);
}

const SUBJECT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["invoice_id", "invoice"],
  ["obligation_id", "obligation"],
  ["transaction_id", "transaction"],
  ["account_id", "account"],
  ["source_account_id", "account"],
  ["counterparty_id", "counterparty"],
  ["vendor_id", "counterparty"],
  ["document_id", "document"],
  ["raw_artifact_id", "raw_artifact"],
  ["policy_decision_id", "policy_decision"],
  ["goal_id", "goal"],
  ["budget_id", "budget"],
  ["trip_id", "trip"],
  ["debt_account_id", "account"],
];

function narrativeForGenericProposal(
  action: string,
  agentKey: string | null,
  subject: { kind: string; ref: string } | null,
): string {
  const agentLabel = agentKey !== null ? agentKey.replaceAll("_", " ") : "agent";
  const actionLabel = action.replaceAll("_", " ");
  const subjectLabel = subject !== null ? ` for ${subject.kind} ${subject.ref}` : "";
  return `${agentLabel} recommends ${actionLabel}${subjectLabel}.`;
}

function summaryForGenericProposal(
  action: string,
  agentKey: string | null,
  subject: { kind: string; ref: string } | null,
): string {
  const actionLabel = action.replaceAll("_", " ");
  const agentLabel = agentKey !== null ? agentKey.replaceAll("_", " ") : "agent";
  const subjectLabel = subject !== null ? ` on ${subject.kind}` : "";
  return `${agentLabel} ${actionLabel}${subjectLabel}.`;
}

export function evidenceRefsForAction(
  items: readonly EvidenceRef[],
): Array<{ kind: string; ref: string }> {
  return items.map((item) => ({ kind: item.kind, ref: item.ref }));
}

export function policyConfidenceForEvidence(
  evidence: EvidenceBundle,
  routedConfidence?: number,
): number | null {
  const candidates = [
    ...(validUnit(routedConfidence) ? [routedConfidence] : []),
    ...(validUnit(evidence.evidence_score) ? [evidence.evidence_score] : []),
    ...evidence.items
      .map((item) => item.confidence)
      .filter((confidence): confidence is number => validUnit(confidence)),
  ];
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

function validUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export { str as readString };
