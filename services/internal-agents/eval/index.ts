import { collectionsHandler } from "../src/collections/handler.js";
import { cashForecastHandler } from "../src/cash_forecast/handler.js";
import { complianceHandler } from "../src/compliance/handler.js";
import { disputeHandler } from "../src/dispute/handler.js";
import { fraudAnomalyHandler } from "../src/fraud_anomaly/handler.js";
import { paymentHandler } from "../src/payment/handler.js";
import { reconciliationHandler } from "../src/reconciliation/handler.js";
import { revenueIntelHandler } from "../src/revenue_intel/handler.js";
import { subscriptionHandler } from "../src/subscription/handler.js";
import { treasuryHandler } from "../src/treasury/handler.js";
import { vendorRiskHandler } from "../src/vendor_risk/handler.js";
import type { InternalAgentHandler } from "../src/handler.js";

export const EVAL_FIXED_CLOCK = new Date("2026-07-18T00:00:00.000Z");

export const evalHandlers: Readonly<Record<string, InternalAgentHandler>> = {
  cash_forecast: cashForecastHandler,
  collections: collectionsHandler,
  compliance: complianceHandler,
  dispute: disputeHandler,
  fraud_anomaly: fraudAnomalyHandler,
  payment: paymentHandler,
  reconciliation: reconciliationHandler,
  revenue_intel: revenueIntelHandler,
  subscription: subscriptionHandler,
  treasury: treasuryHandler,
  vendor_risk: vendorRiskHandler,
};

export { cashForecastScenarios } from "./cash_forecast.scenarios.js";
export { collectionsScenarios } from "./collections.scenarios.js";
export { complianceScenarios } from "./compliance.scenarios.js";
export { disputeScenarios } from "./dispute.scenarios.js";
export { fraudAnomalyScenarios } from "./fraud_anomaly.scenarios.js";
export { paymentScenarios } from "./payment.scenarios.js";
export { reconciliationScenarios } from "./reconciliation.scenarios.js";
export { revenueIntelScenarios } from "./revenue_intel.scenarios.js";
export { subscriptionScenarios } from "./subscription.scenarios.js";
export { treasuryScenarios } from "./treasury.scenarios.js";
export { vendorRiskScenarios } from "./vendor_risk.scenarios.js";
export { metricRegistry } from "./metrics.js";
export { compareToBaseline, runGoldenEval, summarizeReport } from "./runner.js";
export type {
  BaselineComparison,
  EvalAgentAggregate,
  EvalFieldScore,
  EvalScenarioResult,
  GoldenEvalBaseline,
  GoldenEvalReport,
  GoldenScenario,
} from "./types.js";
