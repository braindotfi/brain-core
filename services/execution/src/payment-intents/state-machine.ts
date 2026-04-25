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

import { brainError } from "@brain/api/shared";

export type PaymentIntentState =
  | "proposed"
  | "pending_approval"
  | "approved"
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
      return to === "pending_approval" || to === "approved" || to === "rejected" || to === "cancelled";
    case "pending_approval":
      return to === "approved" || to === "rejected";
    case "approved":
      return to === "executed" || to === "rejected" || to === "failed";
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
