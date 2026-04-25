/**
 * IPaymentIntentService — Agent ↔ Ledger boundary.
 *
 * Owns the PaymentIntent lifecycle. Lives at the boundary because the
 * row is a Ledger entity but the lifecycle is governed by Agent + Policy:
 *
 *   created_by_agent_id is set ⇒ Agent layer wrote the intent
 *   policy_decision_id is set ⇒ Policy evaluation completed
 *   status = executed ⇒ §6 gate passed AND rail dispatched
 *
 * Layer boundary invariants:
 *  - status = executed unreachable without policy_decision_id.
 *  - status = executed unreachable without an audit-before AND audit-after pair.
 *  - The §6 13-step gate is the only path from approved → executed.
 *  - Rejection is terminal. Cancellation is reachable from `proposed` only.
 */

import type {
  Currency,
  DecimalString,
  LedgerCommonFields,
  ServiceCallContext,
} from "./types.js";

export type PaymentIntentActionType =
  | "ach_outbound"
  | "ach_inbound"
  | "wire"
  | "onchain_transfer"
  | "erp_writeback"
  | "card_payment"
  | "other";

export type PaymentIntentStatus =
  | "proposed"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executed"
  | "failed"
  | "cancelled";

export interface PaymentIntent extends LedgerCommonFields {
  created_by_agent_id: string | null;
  action_type: PaymentIntentActionType;
  source_account_id: string;
  destination_counterparty_id: string;
  amount: DecimalString;
  currency: Currency;
  obligation_id: string | null;
  invoice_id: string | null;
  status: PaymentIntentStatus;
  policy_decision_id: string | null;
  approval_ids: string[];
  execution_receipt_ids: string[];
}

export interface CreatePaymentIntentInput {
  action_type: PaymentIntentActionType;
  source_account_id: string;
  destination_counterparty_id: string;
  amount: DecimalString;
  currency: Currency;
  obligation_id?: string;
  invoice_id?: string;
  agent_id?: string;
  evidence_ids?: string[];
}

export interface ExecuteResult {
  payment_intent_id: string;
  execution_id: string;
  rail: string;
  status: "dispatched" | "in_flight";
}

export interface IPaymentIntentService {
  create(ctx: ServiceCallContext, input: CreatePaymentIntentInput): Promise<PaymentIntent>;
  get(ctx: ServiceCallContext, id: string): Promise<PaymentIntent | null>;
  list(ctx: ServiceCallContext, f: { status?: PaymentIntentStatus; agent_id?: string; limit?: number }): Promise<PaymentIntent[]>;
  approve(ctx: ServiceCallContext, id: string): Promise<PaymentIntent>;
  reject(ctx: ServiceCallContext, id: string, reason?: string): Promise<PaymentIntent>;
  cancel(ctx: ServiceCallContext, id: string): Promise<PaymentIntent>;

  /**
   * Execute. Runs the §6 pre-execution gate. Returns 202 dispatch on success.
   * Throws `payment_intent_gate_failed` on any check failure with the failing
   * check index in details.
   */
  execute(ctx: ServiceCallContext, id: string): Promise<ExecuteResult>;
}
