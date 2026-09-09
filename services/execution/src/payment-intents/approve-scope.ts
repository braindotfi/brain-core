import { requireScope, type Scope } from "@brain/shared";

export const PAYMENT_INTENT_APPROVE_SCOPE: Scope = "payment_intent:approve";

export function requirePaymentIntentApproveScope(held: ReadonlyArray<string>): void {
  requireScope(held, PAYMENT_INTENT_APPROVE_SCOPE);
}
