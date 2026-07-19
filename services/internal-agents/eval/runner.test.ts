import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVAL_FIXED_CLOCK,
  cashForecastScenarios,
  collectionsScenarios,
  compareToBaseline,
  evalHandlers,
  fraudAnomalyScenarios,
  metricRegistry,
  reconciliationScenarios,
  runGoldenEval,
  vendorRiskScenarios,
} from "./index.js";
import type { GoldenEvalBaseline, GoldenScenario } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("golden eval runner", () => {
  it("scores a known-good Collections scenario as passing", () => {
    const report = runGoldenEval({
      handlers: evalHandlers,
      metrics: metricRegistry,
      scenarios: [collectionsScenarios[0]!],
      fixedClock: EVAL_FIXED_CLOCK,
    });

    expect(report.scenarios).toHaveLength(1);
    expect(report.scenarios[0]).toMatchObject({
      agent_key: "collections",
      passed: true,
      score: 1,
    });
    expect(report.scenarios[0]?.fields.map((field) => field.field)).toEqual([
      "recommended_action",
      "escalation_tier",
      "aging_tier",
      "ranked_recommendations.top1",
    ]);
  });

  it("scores a known-bad expected label as failing", () => {
    const scenario: GoldenScenario = {
      ...collectionsScenarios[0]!,
      name: "known bad expected action",
      expected: {
        ...collectionsScenarios[0]!.expected,
        recommended_action: "escalate",
      },
    };

    const report = runGoldenEval({
      handlers: evalHandlers,
      metrics: metricRegistry,
      scenarios: [scenario],
      fixedClock: EVAL_FIXED_CLOCK,
    });

    expect(report.scenarios[0]?.passed).toBe(false);
    expect(report.scenarios[0]?.score).toBeLessThan(1);
  });

  it("passes the committed baseline", () => {
    const report = runGoldenEval({
      handlers: evalHandlers,
      metrics: metricRegistry,
      scenarios: [
        ...collectionsScenarios,
        ...reconciliationScenarios,
        ...cashForecastScenarios,
        ...vendorRiskScenarios,
        ...fraudAnomalyScenarios,
      ],
      fixedClock: EVAL_FIXED_CLOCK,
    });
    const baseline = readBaseline();

    expect(compareToBaseline(report, baseline)).toEqual({ passed: true, failures: [] });
    expect(report.aggregate.collections).toMatchObject({
      scenario_count: baseline.agents.collections?.scenario_count,
      passed_count: baseline.agents.collections?.scenario_count,
      score: baseline.agents.collections?.minimum_score,
    });
    expect(report.aggregate.reconciliation).toMatchObject({
      scenario_count: baseline.agents.reconciliation?.scenario_count,
      passed_count: baseline.agents.reconciliation?.scenario_count,
      score: baseline.agents.reconciliation?.minimum_score,
    });
    expect(report.aggregate.cash_forecast).toMatchObject({
      scenario_count: baseline.agents.cash_forecast?.scenario_count,
      passed_count: baseline.agents.cash_forecast?.scenario_count,
      score: baseline.agents.cash_forecast?.minimum_score,
    });
    expect(report.aggregate.vendor_risk).toMatchObject({
      scenario_count: baseline.agents.vendor_risk?.scenario_count,
      passed_count: baseline.agents.vendor_risk?.scenario_count,
      score: baseline.agents.vendor_risk?.minimum_score,
    });
    expect(report.aggregate.fraud_anomaly).toMatchObject({
      scenario_count: baseline.agents.fraud_anomaly?.scenario_count,
      passed_count: baseline.agents.fraud_anomaly?.scenario_count,
      score: baseline.agents.fraud_anomaly?.minimum_score,
    });
  });

  it("fails the regression gate when aggregate score drops below baseline", () => {
    const report = runGoldenEval({
      handlers: evalHandlers,
      metrics: metricRegistry,
      scenarios: [
        {
          ...collectionsScenarios[0]!,
          name: "regression expected action",
          expected: {
            ...collectionsScenarios[0]!.expected,
            recommended_action: "escalate",
          },
        },
      ],
      fixedClock: EVAL_FIXED_CLOCK,
    });
    const baseline: GoldenEvalBaseline = {
      version: 1,
      fixed_clock: EVAL_FIXED_CLOCK.toISOString(),
      agents: {
        collections: {
          minimum_score: 1,
          scenario_count: 1,
        },
      },
    };

    expect(compareToBaseline(report, baseline)).toMatchObject({ passed: false });
  });
});

function readBaseline(): GoldenEvalBaseline {
  return JSON.parse(readFileSync(resolve(here, "baseline.json"), "utf8")) as GoldenEvalBaseline;
}
