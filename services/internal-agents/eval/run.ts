import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  EVAL_FIXED_CLOCK,
  cashForecastScenarios,
  collectionsScenarios,
  complianceScenarios,
  compareToBaseline,
  disputeScenarios,
  evalHandlers,
  fraudAnomalyScenarios,
  metricRegistry,
  paymentScenarios,
  reconciliationScenarios,
  revenueIntelScenarios,
  runGoldenEval,
  summarizeReport,
  subscriptionScenarios,
  treasuryScenarios,
  vendorRiskScenarios,
} from "./index.js";
import type { GoldenEvalBaseline } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = resolve(here, "baseline.json");

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const updateBaseline = args.has("--update-baseline");
  const report = runGoldenEval({
    handlers: evalHandlers,
    metrics: metricRegistry,
    scenarios: [
      ...collectionsScenarios,
      ...reconciliationScenarios,
      ...cashForecastScenarios,
      ...vendorRiskScenarios,
      ...fraudAnomalyScenarios,
      ...complianceScenarios,
      ...disputeScenarios,
      ...revenueIntelScenarios,
      ...subscriptionScenarios,
      ...treasuryScenarios,
      ...paymentScenarios,
    ],
    fixedClock: EVAL_FIXED_CLOCK,
  });

  if (updateBaseline) {
    const nextBaseline: GoldenEvalBaseline = {
      version: 1,
      fixed_clock: report.fixed_clock,
      agents: Object.fromEntries(
        Object.values(report.aggregate).map((aggregate) => [
          aggregate.agent_key,
          {
            minimum_score: aggregate.score,
            scenario_count: aggregate.scenario_count,
          },
        ]),
      ),
    };
    await writeFile(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`, "utf8");
    process.stderr.write("Updated golden eval baseline. Review this diff before committing.\n");
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as GoldenEvalBaseline;
    const comparison = compareToBaseline(report, baseline);
    if (!comparison.passed) {
      process.stderr.write(`${comparison.failures.join("\n")}\n`);
      process.exitCode = 1;
    }
  }

  process.stderr.write(`${summarizeReport(report)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
