/**
 * §9.5 PaymentIntent state machine.
 *
 *   [proposed] ──> [pending_approval] ──> [approved] ──> [executed]
 *       │              │                       │              │
 *       │              │                       │              v
 *       │              │                       │         [failed]
 *       │              │                       v
 *       │              │                  [rejected]
 *       │              v
 *       │         [rejected]
 *       v
 *   [cancelled]
 */

import { brainError } from "@brain/shared";

export type PaymentIntentState =
  | "proposed"
  | "pending_approval"
  | "approved"
  | "paused"
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
      return to === "approved" || to === "rejected";
    case "approved":
      // Kill-switch (1b.3): approved ⇄ paused; otherwise execute/reject/fail.
      return to === "executed" || to === "rejected" || to === "failed" || to === "paused";
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
