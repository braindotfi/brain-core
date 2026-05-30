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

import { brainError, type PaymentIntentStatus } from "@brain/shared";
import {
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.js";

interface PaymentIntentProposeInput {
  action_type:
    | "ach_outbound"
    | "ach_inbound"
    | "wire"
    | "onchain_transfer"
    | "erp_writeback"
    | "card_payment"
    | "x402_settle"
    | "escrow_release";
  source_account_id: string;
  destination_counterparty_id: string;
  amount: string;
  currency: string;
  obligation_id?: string;
  invoice_id?: string;
  evidence_ids?: string[];
  /** x402_settle: on-chain USDC recipient (RFC 0001 §6.1). */
  pay_to?: string;
  /** escrow_release: on-chain BrainEscrow id + keccak256 job-terms commitment (RFC 0001 §7.6). */
  escrow_id?: string;
  job_terms_hash?: string;
}

const ACTION_TYPES = new Set([
  "ach_outbound",
  "ach_inbound",
  "wire",
  "onchain_transfer",
  "erp_writeback",
  "card_payment",
  // On-chain settlement types — first-class on the HTTP route and the §6 gate,
  // now requestable by NAME from MCP too. There is no implicit resolver from
  // onchain_transfer; the agent names x402_settle / escrow_release directly.
  "x402_settle",
  "escrow_release",
]);

/** EVM address shape for the x402 settlement recipient (mirrors the HTTP route). */
const ONCHAIN_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** bytes32 hex shape for the escrow id + job-terms commitment. */
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export const paymentIntentProposeTool: Tool<PaymentIntentProposeInput> = {
  name: "payment_intent.propose",
  description:
    "Propose a financial action. `action_type` is named explicitly — fiat rails " +
    "(ach_outbound/ach_inbound/wire/card_payment/erp_writeback, ISO-4217) or on-chain " +
    "settlement (`x402_settle` with `pay_to`, or `escrow_release` with `escrow_id` + " +
    "`job_terms_hash`, both USDC). Brain evaluates the active policy and returns the " +
    "PaymentIntent with its PolicyDecision attached. Execution is NOT performed by this " +
    "tool. See resource brain://payments/action_types for the full vocabulary.",
  requiredScopes: ["payment_intent:propose"],
  inputSchema: {
    type: "object",
    required: [
      "action_type",
      "source_account_id",
      "destination_counterparty_id",
      "amount",
      "currency",
    ],
    properties: {
      action_type: { type: "string", enum: Array.from(ACTION_TYPES) },
      source_account_id: { type: "string" },
      destination_counterparty_id: { type: "string" },
      amount: { type: "string", pattern: "^\\d+(\\.\\d+)?$" },
      // 3-letter ISO-4217 for fiat rails; USDC (4) for the on-chain settlements.
      currency: { type: "string", pattern: "^[A-Z]{3,4}$" },
      obligation_id: { type: "string" },
      invoice_id: { type: "string" },
      evidence_ids: { type: "array", items: { type: "string" } },
      pay_to: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      escrow_id: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      job_terms_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
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
    const onchain = actionType === "x402_settle" || actionType === "escrow_release";
    const currency = requireString(params, "currency");
    // Fiat rails are ISO-4217 (3 letters); on-chain settlements are USDC (D-4).
    if (onchain ? currency !== "USDC" : !/^[A-Z]{3}$/.test(currency)) {
      throw {
        code: "request_params_invalid",
        message: onchain
          ? "on-chain settlement currency must be USDC"
          : "currency must be ISO-4217 (3 letters)",
        details: { action_type: actionType, currency },
      };
    }
    const out: PaymentIntentProposeInput = {
      action_type: actionType as PaymentIntentProposeInput["action_type"],
      source_account_id: requireString(params, "source_account_id"),
      destination_counterparty_id: requireString(params, "destination_counterparty_id"),
      amount: requireString(params, "amount"),
      currency,
    };
    if (typeof params.obligation_id === "string") out.obligation_id = params.obligation_id;
    if (typeof params.invoice_id === "string") out.invoice_id = params.invoice_id;
    if (Array.isArray(params.evidence_ids)) {
      out.evidence_ids = params.evidence_ids.filter((s): s is string => typeof s === "string");
    }
    // x402_settle needs the on-chain recipient up front; gate check 6.5
    // re-validates it against the resolved counterparty's address.
    if (actionType === "x402_settle") {
      const payTo = requireString(params, "pay_to");
      if (!ONCHAIN_ADDRESS.test(payTo)) {
        throw {
          code: "request_params_invalid",
          message: "x402_settle requires a 0x EVM pay_to address",
          details: { pay_to: payTo },
        };
      }
      out.pay_to = payTo;
    }
    // escrow_release needs the on-chain escrow id + job-terms commitment; gate
    // check 6.6 binds them to the on-chain BrainEscrow lock before release.
    if (actionType === "escrow_release") {
      const escrowId = requireString(params, "escrow_id");
      const jobTermsHash = requireString(params, "job_terms_hash");
      if (!BYTES32.test(escrowId) || !BYTES32.test(jobTermsHash)) {
        throw {
          code: "request_params_invalid",
          message: "escrow_release requires 0x bytes32 escrow_id and job_terms_hash",
          details: { escrow_id: escrowId, job_terms_hash: jobTermsHash },
        };
      }
      out.escrow_id = escrowId;
      out.job_terms_hash = jobTermsHash;
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
      ...(input.pay_to !== undefined ? { pay_to: input.pay_to } : {}),
      ...(input.escrow_id !== undefined ? { escrow_id: input.escrow_id } : {}),
      ...(input.job_terms_hash !== undefined ? { job_terms_hash: input.job_terms_hash } : {}),
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

// ---------------------------------------------------------------------------
// payment_intent.cancel — item 17.
// ---------------------------------------------------------------------------

/**
 * Cancel an intent the calling agent itself proposed, while it's still in a
 * pre-execution state. Authorization: the intent's `created_by_agent_id` must
 * equal the calling agent's id; the underlying state machine also enforces
 * that cancel is reachable from `proposed` / `pending_approval` only.
 */
interface PaymentIntentCancelInput {
  intent_id: string;
}

const CANCELLABLE_STATUSES = new Set<PaymentIntentStatus>(["proposed", "pending_approval"]);

export const paymentIntentCancelTool: Tool<PaymentIntentCancelInput> = {
  name: "payment_intent.cancel",
  description:
    "Cancel a PaymentIntent the calling agent proposed, while it is still in `proposed` or `pending_approval` state. Only the proposing agent can cancel; tenant-scoped by the underlying service.",
  requiredScopes: ["payment_intent:propose"],
  inputSchema: {
    type: "object",
    required: ["intent_id"],
    properties: {
      intent_id: { type: "string" },
    },
  },
  parseInput(params): PaymentIntentCancelInput {
    return { intent_id: requireString(params, "intent_id") };
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const existing = await ctx.paymentIntents.get(ctx.ctx, input.intent_id);
    if (existing === null) {
      throw brainError("payment_intent_not_found", "no such payment intent");
    }
    // Permission: only the proposing agent may cancel via MCP. (Use the
    // closest existing 403 code; there is no per-resource "forbidden" code.)
    if (existing.created_by_agent_id !== ctx.agent.id) {
      throw brainError(
        "auth_scope_insufficient",
        "only the proposing agent may cancel this intent",
        { details: { agent_id: ctx.agent.id } },
      );
    }
    if (!CANCELLABLE_STATUSES.has(existing.status)) {
      throw brainError(
        "payment_intent_invalid_state",
        `cancel not allowed from status=${existing.status}`,
        { details: { status: existing.status } },
      );
    }
    const cancelled = await ctx.paymentIntents.cancel(ctx.ctx, input.intent_id);
    return {
      payload: cancelled,
      summary:
        `PaymentIntent \`${cancelled.id}\` cancelled (was **${existing.status}**).\n` +
        `Action: ${cancelled.action_type} of ${cancelled.amount} ${cancelled.currency}`,
    };
  },
};

// ---------------------------------------------------------------------------
// payment_intent.list — item 17.
// ---------------------------------------------------------------------------

/**
 * List the calling agent's PaymentIntents. Tenant-scoped by the underlying
 * service; the agent_id filter is forced server-side so an agent never sees
 * another agent's intents — even if it provides agent_id in arguments.
 */
interface PaymentIntentListInput {
  status?: PaymentIntentStatus;
  limit?: number;
}

const VALID_STATUSES = new Set<PaymentIntentStatus>([
  "proposed",
  "pending_approval",
  "approved",
  "paused",
  "dispatching",
  "rejected",
  "executed",
  "failed",
  "cancelled",
]);

export const paymentIntentListTool: Tool<PaymentIntentListInput> = {
  name: "payment_intent.list",
  description:
    "List the calling agent's own PaymentIntents (tenant- and agent-scoped). Optional `status` filter and `limit` (1–100). Cannot list intents proposed by other agents.",
  requiredScopes: ["ledger:read"],
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: Array.from(VALID_STATUSES) },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  parseInput(params): PaymentIntentListInput {
    const out: PaymentIntentListInput = {};
    const status = optionalString(params, "status");
    if (status !== undefined) {
      if (!VALID_STATUSES.has(status as PaymentIntentStatus)) {
        throw {
          code: "request_params_invalid",
          message: "status invalid",
          details: { status, allowed: Array.from(VALID_STATUSES) },
        };
      }
      out.status = status as PaymentIntentStatus;
    }
    const limit = optionalNumber(params, "limit");
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw {
          code: "request_params_invalid",
          message: "limit must be an integer in [1, 100]",
          details: { limit },
        };
      }
      out.limit = limit;
    }
    return out;
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    // Force agent_id = calling agent — never trust client-supplied agent_id.
    const items = await ctx.paymentIntents.list(ctx.ctx, {
      agent_id: ctx.agent.id,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const filterLine = input.status !== undefined ? ` (status=${input.status})` : "";
    const lines = items
      .slice(0, 10)
      .map(
        (pi) => `- \`${pi.id}\` — ${pi.action_type} ${pi.amount} ${pi.currency} → **${pi.status}**`,
      );
    const more = items.length > 10 ? `\n(${items.length - 10} more)` : "";
    return {
      payload: items,
      summary: `Found **${items.length}** PaymentIntent(s)${filterLine} for agent \`${ctx.agent.id}\`.\n${lines.join("\n")}${more}`,
    };
  },
};

export const paymentIntentTools: Tool[] = [
  paymentIntentProposeTool as unknown as Tool,
  paymentIntentCancelTool as unknown as Tool,
  paymentIntentListTool as unknown as Tool,
];
