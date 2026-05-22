/**
 * Internal-agent catalog.
 *
 * The router selects over `internalAgentCatalog`; the worker dispatches the
 * selected agent's action through `internalAgentHandlers`. Adding an agent in
 * a later phase means adding its definition + handler here — no router change.
 */

import type { InternalAgentDefinition } from "@brain/schemas";
import { collectionsDefinition } from "./collections/definition.js";
import { collectionsHandler } from "./collections/handler.js";
import { treasuryDefinition } from "./treasury/definition.js";
import { treasuryHandler } from "./treasury/handler.js";
import { reconciliationDefinition } from "./reconciliation/definition.js";
import { reconciliationHandler } from "./reconciliation/handler.js";
import { paymentDefinition } from "./payment/definition.js";
import { paymentHandler } from "./payment/handler.js";
import { subscriptionDefinition } from "./subscription/definition.js";
import { subscriptionHandler } from "./subscription/handler.js";
import { vendorRiskDefinition } from "./vendor_risk/definition.js";
import { vendorRiskHandler } from "./vendor_risk/handler.js";
import { cashForecastDefinition } from "./cash_forecast/definition.js";
import { cashForecastHandler } from "./cash_forecast/handler.js";
import { disputeDefinition } from "./dispute/definition.js";
import { disputeHandler } from "./dispute/handler.js";
import { complianceDefinition } from "./compliance/definition.js";
import { complianceHandler } from "./compliance/handler.js";
import { revenueIntelDefinition } from "./revenue_intel/definition.js";
import { revenueIntelHandler } from "./revenue_intel/handler.js";
// Phase 3 — consumer agents.
import { personalBudgetDefinition } from "./personal_budget/definition.js";
import { personalBudgetHandler } from "./personal_budget/handler.js";
import { billManagementDefinition } from "./bill_management/definition.js";
import { billManagementHandler } from "./bill_management/handler.js";
import { savingsDefinition } from "./savings/definition.js";
import { savingsHandler } from "./savings/handler.js";
import { debtOptimizationDefinition } from "./debt_optimization/definition.js";
import { debtOptimizationHandler } from "./debt_optimization/handler.js";
import { fraudAnomalyDefinition } from "./fraud_anomaly/definition.js";
import { fraudAnomalyHandler } from "./fraud_anomaly/handler.js";
import { taxPrepDefinition } from "./tax_prep/definition.js";
import { taxPrepHandler } from "./tax_prep/handler.js";
import { travelFinanceDefinition } from "./travel_finance/definition.js";
import { travelFinanceHandler } from "./travel_finance/handler.js";
import { financialHealthDefinition } from "./financial_health/definition.js";
import { financialHealthHandler } from "./financial_health/handler.js";
import { purchaseAdvisorDefinition } from "./purchase_advisor/definition.js";
import { purchaseAdvisorHandler } from "./purchase_advisor/handler.js";
import type { InternalAgentHandler } from "./handler.js";

export const internalAgentCatalog: readonly InternalAgentDefinition[] = [
  collectionsDefinition,
  treasuryDefinition,
  reconciliationDefinition,
  paymentDefinition,
  subscriptionDefinition,
  vendorRiskDefinition,
  cashForecastDefinition,
  disputeDefinition,
  complianceDefinition,
  revenueIntelDefinition,
  personalBudgetDefinition,
  billManagementDefinition,
  savingsDefinition,
  debtOptimizationDefinition,
  fraudAnomalyDefinition,
  taxPrepDefinition,
  travelFinanceDefinition,
  financialHealthDefinition,
  purchaseAdvisorDefinition,
];

export const internalAgentHandlers: Readonly<Record<string, InternalAgentHandler>> = {
  collections: collectionsHandler,
  treasury: treasuryHandler,
  reconciliation: reconciliationHandler,
  payment: paymentHandler,
  subscription: subscriptionHandler,
  vendor_risk: vendorRiskHandler,
  cash_forecast: cashForecastHandler,
  dispute: disputeHandler,
  compliance: complianceHandler,
  revenue_intel: revenueIntelHandler,
  personal_budget: personalBudgetHandler,
  bill_management: billManagementHandler,
  savings: savingsHandler,
  debt_optimization: debtOptimizationHandler,
  fraud_anomaly: fraudAnomalyHandler,
  tax_prep: taxPrepHandler,
  travel_finance: travelFinanceHandler,
  financial_health: financialHealthHandler,
  purchase_advisor: purchaseAdvisorHandler,
};
