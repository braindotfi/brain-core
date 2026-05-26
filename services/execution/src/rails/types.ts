/**
 * Execution rail interface.
 *
 * A rail accepts a proposal's action and attempts to execute it. It returns
 * a dispatched receipt — the execution row starts in `dispatched` state.
 * Provider callbacks (ACH return, ERP confirm, on-chain receipt) drive the
 * transition to `in_flight` and then `completed` or `failed` via handlers
 * registered separately.
 */

export type RailKind = "bank_ach" | "erp_writeback" | "onchain_base" | "notification" | "x402_base";

export interface RailDispatchInput {
  tenantId: string;
  proposalId: string;
  executionId: string;
  action: Record<string, unknown>;
  idempotencyKey: string;
}

export interface RailDispatchResult {
  receipt: Record<string, unknown>;
}

export interface Rail {
  readonly kind: RailKind;
  dispatch(input: RailDispatchInput): Promise<RailDispatchResult>;
}
