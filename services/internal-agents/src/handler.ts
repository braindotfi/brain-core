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
import type { EvidenceBundle, EvidenceRef } from "./evidence.js";

export type ProposedAction =
  | { readonly channel: "agent"; readonly action: Record<string, unknown> }
  | { readonly channel: "payment_intent"; readonly intent: CreatePaymentIntentInput };

export interface HandlerInput {
  readonly action: string;
  readonly context: Record<string, unknown>;
  readonly evidence: EvidenceBundle;
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
  return {
    channel: "agent",
    action: {
      type: input.action,
      invoice_id: str(input.context.invoice_id) || null,
      counterparty_id: str(input.context.counterparty_id) || null,
      evidence_refs: evidenceRefsForAction(input.evidence.items),
    },
  };
}

export function evidenceRefsForAction(
  items: readonly EvidenceRef[],
): Array<{ kind: string; ref: string }> {
  return items.map((item) => ({ kind: item.kind, ref: item.ref }));
}

export { str as readString };
