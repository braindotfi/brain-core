/**
 * §9.5 PaymentIntent state machine.
 *
 *   [proposed] ──> [pending_approval] ──> [awaiting_second_approval] ──> [approved] ──> [dispatching] ──> [executed]
 *       │              │                       │              │               │
 *       │              │                       │              v               v
 *       │              │                       │           [failed]        [failed]
 *       │              │                       v
 *       │              │                  [rejected]
 *       │              v
 *       │         [rejected]
 *       v
 *   [cancelled]
 *
 * H-04 durable-execution outbox. `execute` no longer drives approved → executed
 * synchronously. It atomically enqueues an execution_outbox row and moves
 * approved → dispatching; the outbox worker then dispatches the rail and calls
 * back into PaymentIntentService to settle dispatching → executed (or → failed).
 * The intermediate `dispatching` state is what makes a crash between rail
 * dispatch and the final state write recoverable — the row is still claimable.
 */

import { brainError } from "@brain/shared";

export type PaymentIntentState =
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

export function isValidPaymentIntentTransition(
  from: PaymentIntentState,
  to: PaymentIntentState,
): boolean {
  switch (from) {
    case "proposed":
      return (
        to === "pending_approval" || to === "approved" || to === "rejected" || to === "cancelled"
      );
    case "pending_approval":
      return to === "awaiting_second_approval" || to === "approved" || to === "rejected";
    case "awaiting_second_approval":
      return to === "approved" || to === "rejected";
    case "approved":
      // Kill-switch (1b.3): approved ⇄ paused. H-04: execute now hands off to
      // the outbox via approved → dispatching (no direct approved → executed).
      // reject/fail remain reachable for synchronous pre-dispatch rejection.
      return to === "dispatching" || to === "rejected" || to === "failed" || to === "paused";
    case "dispatching":
      // H-04: the outbox worker settles the dispatched action.
      return to === "executed" || to === "failed";
    case "paused":
      // Resume re-runs the live gate before re-entering approved; cancel is terminal.
      return to === "approved" || to === "cancelled";
    case "executed":
      return to === "failed"; // post-execution rail reversal still emits a transition
    case "rejected":
    case "failed":
    case "cancelled":
      return false;
  }
}

export function assertPaymentIntentTransition(
  from: PaymentIntentState,
  to: PaymentIntentState,
): void {
  if (!isValidPaymentIntentTransition(from, to)) {
    throw brainError(
      "payment_intent_invalid_state",
      `invalid PaymentIntent transition ${from} → ${to}`,
    );
  }
}
