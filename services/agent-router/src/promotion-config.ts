/**
 * Live money-movement promotion config (Agent Autonomy v3, 1b / H-24).
 *
 * THE one place an agent is promoted from shadow to live. Default = empty =>
 * every agent is shadowed (no money moves). Promote one agent at a time by
 * adding it with the rails it may use, e.g.:
 *
 *     export const LIVE_AGENTS: PromotionConfig = {
 *       liveAgents: { savings: ["ach"] },
 *     };
 *
 * SAFETY GATE (H-24): a change to this file that promotes an agent is blocked in
 * CI until `scripts/check-promotion-readiness.mjs --agent <key>` is all-green
 * (outbox/RLS, gate checks 9.5 + 11.5, typed rail receipts, replay endpoint,
 * halt-category tests, adversarial coverage, on-chain behavior hash, session-key
 * grants, …). Shadow-by-default + this gate are how a money-mover reaches prod
 * safely. See Brain_Engineering_Standards.md §"Promotion readiness".
 */

import type { PromotionConfig } from "./promotion.js";

export const LIVE_AGENTS: PromotionConfig = {
  liveAgents: {
    // Business agents
    // x402 + escrow added: payment handles x402_settle / escrow_release action types.
    payment: ["ach", "onchain", "x402", "escrow"],
    collections: ["ach", "onchain"],
    treasury: ["ach", "onchain"],
    reconciliation: ["ach", "onchain"],
    subscription: ["ach", "onchain"],
    vendor_risk: ["ach", "onchain"],
    cash_forecast: ["ach", "onchain"],
    dispute: ["ach", "onchain"],
    compliance: ["ach", "onchain"],
    revenue_intel: ["ach", "onchain"],
    // Consumer agents
    personal_budget: ["ach", "onchain"],
    bill_management: ["ach", "onchain"],
    savings: ["ach", "onchain"],
    debt_optimization: ["ach", "onchain"],
    fraud_anomaly: ["ach", "onchain"],
    tax_prep: ["ach", "onchain"],
    travel_finance: ["ach", "onchain"],
    financial_health: ["ach", "onchain"],
    purchase_advisor: ["ach", "onchain"],
  },
};
