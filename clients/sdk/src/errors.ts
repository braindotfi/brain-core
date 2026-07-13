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
    // The live API wraps errors in a `{ error: {...} }` envelope and names the
    // correlation id `request_id`; the OpenAPI `Error` schema is the flatter
    // legacy shape. Read the nested envelope first, fall back to the flat body
    // so both real responses and spec-shaped bodies surface code/trace/details.
    const env = (body as { error?: BrainErrorBody } | undefined)?.error ?? body;
    const code = env?.code ?? "unknown";
    const message = env?.message ?? `Brain API request failed with status ${status}`;
    super(`[${code}] ${message}`);
    this.name = "BrainAPIError";
    this.status = status;
    this.code = code;
    this.traceId =
      (env as { request_id?: string; trace_id?: string } | undefined)?.request_id ??
      env?.trace_id;
    this.details = env?.details;
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
