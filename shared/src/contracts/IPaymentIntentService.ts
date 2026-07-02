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

import type { Currency, DecimalString, LedgerCommonFields, ServiceCallContext } from "./types.js";

export type PaymentIntentActionType =
  | "ach_outbound"
  | "ach_inbound"
  | "wire"
  | "onchain_transfer"
  | "erp_writeback"
  | "card_payment"
  // x402 USDC-on-Base settlement (RFC 0001 §7.1). Shadow-gated end-to-end.
  | "x402_settle"
  // Release of an on-chain BrainEscrow lock (RFC 0001 §7.6). Shadow-gated.
  | "escrow_release"
  | "other";

export type PaymentIntentStatus =
  | "proposed"
  | "pending_approval"
  | "awaiting_second_approval"
  | "approved"
  | "paused"
  | "dispatching"
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
  /**
   * Confidence of the evidence backing this intent (RFC 0004 §5.2). Carried
   * onto the stored row and into the policy VM so `agent.confidence.gte` rules
   * can gate low-confidence intents. Omitted ⇒ defaults to 1.0 (the prior
   * always-confident behavior); document-extracted proposals pass the real
   * value (<= 0.5).
   */
  confidence?: number;
  /**
   * x402 settlement recipient on-chain address (RFC 0001 §6.1). Required by the
   * route for action_type=x402_settle; ignored for other action types. The §6
   * gate (check 6.5) re-validates it against the counterparty's onchain_address.
   */
  pay_to?: string;
  /**
   * On-chain BrainEscrow id (RFC 0001 §7.6). Required by the route for
   * action_type=escrow_release; ignored otherwise. The §6 gate (check 6.6) reads
   * the on-chain escrow and binds it to the intent before release.
   */
  escrow_id?: string;
  /**
   * keccak256 commitment of the escrow job terms (hash-only). Required by the
   * route for action_type=escrow_release; re-checked against the on-chain escrow
   * by gate check 6.6.
   */
  job_terms_hash?: string;
}

export interface ExecuteResult {
  payment_intent_id: string;
  /**
   * H-04: with the durable outbox, execute no longer dispatches the rail
   * synchronously, so there is no execution row yet at 202 time. The
   * execution_id is minted by the worker on dispatch. Null until then.
   */
  execution_id: string | null;
  /** H-04: the execution_outbox row id (exo_…) the worker will pick up. */
  outbox_id: string;
  rail: string;
  status: "dispatching" | "dispatched" | "in_flight";
}

export interface IPaymentIntentService {
  create(ctx: ServiceCallContext, input: CreatePaymentIntentInput): Promise<PaymentIntent>;
  get(ctx: ServiceCallContext, id: string): Promise<PaymentIntent | null>;
  list(
    ctx: ServiceCallContext,
    f: { status?: PaymentIntentStatus; agent_id?: string; limit?: number },
  ): Promise<PaymentIntent[]>;
  approve(
    ctx: ServiceCallContext,
    id: string,
    opts?: { assertedActorId?: string; payloadActorId?: unknown },
  ): Promise<PaymentIntent>;
  reject(ctx: ServiceCallContext, id: string, reason?: string): Promise<PaymentIntent>;
  cancel(ctx: ServiceCallContext, id: string): Promise<PaymentIntent>;

  /**
   * Execute. Runs the §6 pre-execution gate. Returns 202 dispatch on success.
   * Throws `payment_intent_gate_failed` on any check failure with the failing
   * check index in details.
   */
  execute(ctx: ServiceCallContext, id: string): Promise<ExecuteResult>;
}
