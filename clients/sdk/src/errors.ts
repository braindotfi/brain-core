import type { components } from "./generated/openapi.js";

export type BrainErrorBody = components["schemas"]["Error"];
export type PaymentIntent = components["schemas"]["PaymentIntent"];
export type Proposal = components["schemas"]["Proposal"];

export class BrainAPIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: BrainErrorBody | undefined) {
    const code = body?.code ?? "unknown";
    const message = body?.message ?? `Brain API request failed with status ${status}`;
    super(`[${code}] ${message}`);
    this.name = "BrainAPIError";
    this.status = status;
    this.code = code;
    this.traceId = body?.trace_id;
    this.details = body?.details;
  }
}

/**
 * Thrown by compound helpers (`brain.pay`) when the PaymentIntent is in
 * `pending_approval` after policy evaluation — human approval is required
 * before the action can execute. Carries the proposed intent so the caller
 * can route it to an approver and then resume via
 * `brain.payments.approve(intent.id)` + `brain.payments.execute(intent.id)`.
 *
 * The full PolicyDecision (including the list of required approvers) is
 * referenced by `intent.policy_decision_id`. Fetch it via
 * `brain.policy.getDecision(policy_decision_id)` once that surface lands.
 */
export class PolicyApprovalRequiredError extends Error {
  readonly intent: PaymentIntent;
  readonly policyDecisionId: string | null | undefined;

  constructor(intent: PaymentIntent) {
    super(
      `Policy requires approval before this PaymentIntent (${intent.id}) ` +
        `can execute. Approve via brain.payments.approve(id), then execute.`,
    );
    this.name = "PolicyApprovalRequiredError";
    this.intent = intent;
    this.policyDecisionId = intent.policy_decision_id;
  }
}

/**
 * Thrown by compound helpers when the PaymentIntent is in `rejected` after
 * policy evaluation. The intent is persisted but will not execute. Inspect
 * the PolicyDecision (via `intent.policy_decision_id`) for the rule that
 * rejected it.
 */
export class PolicyRejectedError extends Error {
  readonly intent: PaymentIntent;
  readonly policyDecisionId: string | null | undefined;

  constructor(intent: PaymentIntent) {
    super(
      `Policy rejected this PaymentIntent (${intent.id}). ` +
        `See PolicyDecision ${intent.policy_decision_id ?? "<unknown>"} for the rule trace.`,
    );
    this.name = "PolicyRejectedError";
    this.intent = intent;
    this.policyDecisionId = intent.policy_decision_id;
  }
}
