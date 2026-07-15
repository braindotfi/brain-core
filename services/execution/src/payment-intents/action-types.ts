import { brainError, type PaymentIntentActionType } from "@brain/shared";

export const EXECUTABLE_PAYMENT_INTENT_ACTION_TYPES = [
  "ach_outbound",
  "ach_inbound",
  "wire",
  "onchain_transfer",
  "erp_writeback",
  "card_payment",
  "x402_settle",
  "escrow_release",
] as const satisfies readonly PaymentIntentActionType[];

export type ExecutablePaymentIntentActionType =
  (typeof EXECUTABLE_PAYMENT_INTENT_ACTION_TYPES)[number];

const EXECUTABLE_PAYMENT_INTENT_ACTION_TYPE_SET = new Set<string>(
  EXECUTABLE_PAYMENT_INTENT_ACTION_TYPES,
);

export function isExecutablePaymentIntentActionType(
  actionType: string | undefined,
): actionType is ExecutablePaymentIntentActionType {
  return actionType !== undefined && EXECUTABLE_PAYMENT_INTENT_ACTION_TYPE_SET.has(actionType);
}

export function assertExecutablePaymentIntentActionType(
  actionType: string,
): asserts actionType is ExecutablePaymentIntentActionType {
  if (!isExecutablePaymentIntentActionType(actionType)) {
    throw brainError("action_type_not_executable", "action_type is not executable", {
      details: {
        action_type: actionType,
        allowed: EXECUTABLE_PAYMENT_INTENT_ACTION_TYPES,
      },
    });
  }
}
