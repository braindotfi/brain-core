import type {
  BaselineComparison,
  EvalAgentAggregate,
  EvalFieldScore,
  EvalScenarioResult,
  GoldenEvalBaseline,
  GoldenEvalDeps,
  GoldenEvalReport,
} from "./types.js";
import { inputForScenario } from "./types.js";

export function runGoldenEval(deps: GoldenEvalDeps): GoldenEvalReport {
  const results = deps.scenarios.map((scenario): EvalScenarioResult => {
    const handler = deps.handlers[scenario.agent_key];
    const metric = deps.metrics[scenario.agent_key];
    if (handler === undefined) {
      return failedHarnessScenario(scenario.agent_key, scenario.name, "handler_missing");
    }
    if (metric === undefined) {
      return failedHarnessScenario(scenario.agent_key, scenario.name, "metric_missing");
    }

    try {
      const proposed = handler.build(inputForScenario(scenario, deps.fixedClock));
      if (scenario.expect_fail_closed === true) {
        return {
          agent_key: scenario.agent_key,
          name: scenario.name,
          passed: false,
          fail_closed: false,
          error_code: "expected_fail_closed",
          fields: [],
          score: 0,
        };
      }
      if (proposed.channel !== "agent") {
        return failedHarnessScenario(scenario.agent_key, scenario.name, "unexpected_channel");
      }
      const fields = metric.score(proposed.action, scenario.expected);
      return {
        agent_key: scenario.agent_key,
        name: scenario.name,
        passed: fields.length > 0 && fields.every((field) => field.passed),
        fail_closed: false,
        error_code: null,
        fields,
        score: average(fields.map((field) => field.score)),
      };
    } catch (err) {
      if (scenario.expect_fail_closed === true) {
        return {
          agent_key: scenario.agent_key,
          name: scenario.name,
          passed: true,
          fail_closed: true,
          error_code: errorCode(err),
          fields: [],
          score: 1,
        };
      }
      return {
        agent_key: scenario.agent_key,
        name: scenario.name,
        passed: false,
        fail_closed: false,
        error_code: errorCode(err),
        fields: [],
        score: 0,
      };
    }
  });

  return {
    generated_at: deps.generatedAt ?? deps.fixedClock.toISOString(),
    fixed_clock: deps.fixedClock.toISOString(),
    scenarios: results,
    aggregate: aggregateByAgent(results),
  };
}

export function compareToBaseline(
  report: GoldenEvalReport,
  baseline: GoldenEvalBaseline,
): BaselineComparison {
  const failures: string[] = [];
  if (report.fixed_clock !== baseline.fixed_clock) {
    failures.push(
      `fixed clock drifted from ${baseline.fixed_clock} to ${report.fixed_clock}; regenerate baseline explicitly if intentional`,
    );
  }
  for (const [agentKey, expected] of Object.entries(baseline.agents)) {
    const actual = report.aggregate[agentKey];
    if (actual === undefined) {
      failures.push(`${agentKey} missing from eval report`);
      continue;
    }
    if (actual.scenario_count < expected.scenario_count) {
      failures.push(
        `${agentKey} scenario count ${actual.scenario_count} is below baseline ${expected.scenario_count}`,
      );
    }
    if (actual.score < expected.minimum_score) {
      failures.push(
        `${agentKey} score ${actual.score.toFixed(4)} is below baseline ${expected.minimum_score.toFixed(4)}`,
      );
    }
  }
  return { passed: failures.length === 0, failures };
}

export function summarizeReport(report: GoldenEvalReport): string {
  const lines = Object.values(report.aggregate).map(
    (aggregate) =>
      `${aggregate.agent_key}: ${aggregate.passed_count}/${aggregate.scenario_count} scenarios passed, score ${aggregate.score.toFixed(4)}`,
  );
  return lines.join("\n");
}

function failedHarnessScenario(
  agentKey: string,
  name: string,
  error_code: string,
): EvalScenarioResult {
  return {
    agent_key: agentKey,
    name,
    passed: false,
    fail_closed: false,
    error_code,
    fields: [],
    score: 0,
  };
}

function aggregateByAgent(
  results: readonly EvalScenarioResult[],
): Readonly<Record<string, EvalAgentAggregate>> {
  const grouped = new Map<string, EvalScenarioResult[]>();
  for (const result of results) {
    const existing = grouped.get(result.agent_key) ?? [];
    existing.push(result);
    grouped.set(result.agent_key, existing);
  }
  const entries = [...grouped.entries()].map(
    ([agentKey, agentResults]) => [agentKey, aggregateAgent(agentKey, agentResults)] as const,
  );
  return Object.fromEntries(entries);
}

function aggregateAgent(
  agentKey: string,
  results: readonly EvalScenarioResult[],
): EvalAgentAggregate {
  return {
    agent_key: agentKey,
    scenario_count: results.length,
    passed_count: results.filter((result) => result.passed).length,
    score: average(results.map((result) => result.score)),
    field_accuracy: fieldAccuracy(results.flatMap((result) => result.fields)),
  };
}

function fieldAccuracy(fields: readonly EvalFieldScore[]): Readonly<Record<string, number>> {
  const grouped = new Map<string, EvalFieldScore[]>();
  for (const field of fields) {
    const existing = grouped.get(field.field) ?? [];
    existing.push(field);
    grouped.set(field.field, existing);
  }
  return Object.fromEntries(
    [...grouped.entries()].map(([field, scores]) => [
      field,
      average(scores.map((score) => score.score)),
    ]),
  );
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (err instanceof Error) return err.name;
  return "unknown_error";
}
