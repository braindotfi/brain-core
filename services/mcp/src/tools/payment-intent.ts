/**
 * payment_intent.propose — the only money-touching tool.
 *
 * `payment_intent.execute` is deliberately NOT exposed via MCP.
 * Execution is Brain-internal: it requires the §6 13-step
 * pre-execution gate, audit-before/after pairing, and the appropriate
 * approver signatures. An agent proposes; a human (or an internal
 * approver-agent) approves; only then does the execute path run.
 *
 * On `propose`, Brain evaluates policy and returns the resulting
 * PaymentIntent with its PolicyDecision id. The agent gets back enough
 * to know whether the intent is `approved` (auto), `pending_approval`
 * (confirm), or `rejected` — and acts accordingly.
 */

import { requireString, type Tool, type ToolContext, type ToolResult } from "./types.js";

interface PaymentIntentProposeInput {
  action_type:
    | "ach_outbound"
    | "ach_inbound"
    | "wire"
    | "onchain_transfer"
    | "erp_writeback"
    | "card_payment";
  source_account_id: string;
  destination_counterparty_id: string;
  amount: string;
  currency: string;
  obligation_id?: string;
  invoice_id?: string;
  evidence_ids?: string[];
}

const ACTION_TYPES = new Set([
  "ach_outbound",
  "ach_inbound",
  "wire",
  "onchain_transfer",
  "erp_writeback",
  "card_payment",
]);

export const paymentIntentProposeTool: Tool<PaymentIntentProposeInput> = {
  name: "payment_intent.propose",
  description:
    "Propose a financial action. Brain evaluates the active policy and returns the resulting PaymentIntent with its PolicyDecision attached. Execution is NOT performed by this tool.",
  requiredScopes: ["payment_intent:propose"],
  inputSchema: {
    type: "object",
    required: ["action_type", "source_account_id", "destination_counterparty_id", "amount", "currency"],
    properties: {
      action_type: { type: "string", enum: Array.from(ACTION_TYPES) },
      source_account_id: { type: "string" },
      destination_counterparty_id: { type: "string" },
      amount: { type: "string", pattern: "^\\d+(\\.\\d+)?$" },
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      obligation_id: { type: "string" },
      invoice_id: { type: "string" },
      evidence_ids: { type: "array", items: { type: "string" } },
    },
  },
  parseInput(params): PaymentIntentProposeInput {
    const actionType = requireString(params, "action_type");
    if (!ACTION_TYPES.has(actionType)) {
      throw {
        code: "request_params_invalid",
        message: "action_type invalid",
        details: { action_type: actionType, allowed: Array.from(ACTION_TYPES) },
      };
    }
    const out: PaymentIntentProposeInput = {
      action_type: actionType as PaymentIntentProposeInput["action_type"],
      source_account_id: requireString(params, "source_account_id"),
      destination_counterparty_id: requireString(params, "destination_counterparty_id"),
      amount: requireString(params, "amount"),
      currency: requireString(params, "currency"),
    };
    if (typeof params.obligation_id === "string") out.obligation_id = params.obligation_id;
    if (typeof params.invoice_id === "string") out.invoice_id = params.invoice_id;
    if (Array.isArray(params.evidence_ids)) {
      out.evidence_ids = params.evidence_ids.filter((s): s is string => typeof s === "string");
    }
    return out;
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const intent = await ctx.paymentIntents.create(ctx.ctx, {
      action_type: input.action_type,
      source_account_id: input.source_account_id,
      destination_counterparty_id: input.destination_counterparty_id,
      amount: input.amount,
      currency: input.currency,
      ...(input.obligation_id !== undefined ? { obligation_id: input.obligation_id } : {}),
      ...(input.invoice_id !== undefined ? { invoice_id: input.invoice_id } : {}),
      ...(input.evidence_ids !== undefined ? { evidence_ids: input.evidence_ids } : {}),
      agent_id: ctx.agent.id,
    });
    return {
      payload: intent,
      summary:
        `PaymentIntent \`${intent.id}\` created with status **${intent.status}**.\n` +
        `Action: ${intent.action_type} of ${intent.amount} ${intent.currency}\n` +
        `Source: \`${intent.source_account_id}\` → Destination: \`${intent.destination_counterparty_id}\`\n` +
        `Policy decision: \`${intent.policy_decision_id ?? "none"}\`\n\n` +
        statusGuidance(intent.status),
    };
  },
};

function statusGuidance(status: string): string {
  switch (status) {
    case "approved":
      return "The policy decision was `allow`. The intent is awaiting an internal trigger to execute (the agent does NOT execute via MCP).";
    case "pending_approval":
      return "The policy decision was `confirm`. Approvers must sign before this intent can execute. Use `/payment-intents/{id}/approve` (HTTP) or wait for an approver workflow.";
    case "rejected":
      return "The policy decision was `reject`. The intent is terminal. Inspect the PolicyDecision trace for the failing rule.";
    default:
      return "";
  }
}

export const paymentIntentTools: Tool[] = [paymentIntentProposeTool as unknown as Tool];
