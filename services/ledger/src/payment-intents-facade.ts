/**
 * LedgerPaymentIntents — the single sanctioned surface through which the Agent
 * layer (services/execution) reads/writes the `ledger_payment_intents` table.
 *
 * The PaymentIntent row lives in the Ledger schema because it is a financial
 * fact (§2 "every service owns its schema"); the controlled exception (b) lets
 * the Agent layer create/transition it. This facade constrains *how* — the raw
 * repository functions stay internal and a no-restricted-imports rule in
 * eslint.config.mjs blocks execution from importing them directly, so this is
 * the only path. The SQL stays in services/ledger.
 */

import {
  appendApprovalId,
  appendExecutionReceiptId,
  findPaymentIntentById,
  insertPaymentIntent,
  listPaymentIntents,
  pauseApprovedPaymentIntentsByAgent,
  transitionPaymentIntent,
} from "./repository/payment_intents.js";

export const LedgerPaymentIntents = {
  findById: findPaymentIntentById,
  list: listPaymentIntents,
  pauseApprovedByAgent: pauseApprovedPaymentIntentsByAgent,
  insert: insertPaymentIntent,
  transition: transitionPaymentIntent,
  appendApprovalId,
  appendExecutionReceiptId,
} as const;
