import { collectionsHandler } from "../src/collections/handler.js";
import { cashForecastHandler } from "../src/cash_forecast/handler.js";
import { reconciliationHandler } from "../src/reconciliation/handler.js";
import type { InternalAgentHandler } from "../src/handler.js";

export const EVAL_FIXED_CLOCK = new Date("2026-07-18T00:00:00.000Z");

export const evalHandlers: Readonly<Record<string, InternalAgentHandler>> = {
  cash_forecast: cashForecastHandler,
  collections: collectionsHandler,
  reconciliation: reconciliationHandler,
};

export { cashForecastScenarios } from "./cash_forecast.scenarios.js";
export { collectionsScenarios } from "./collections.scenarios.js";
export { reconciliationScenarios } from "./reconciliation.scenarios.js";
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
