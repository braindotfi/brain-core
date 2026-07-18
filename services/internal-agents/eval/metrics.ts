import type { AgentMetric, EvalExpectedFields, EvalFieldScore } from "./types.js";

const EXACT_FIELDS = ["recommended_action", "escalation_tier", "aging_tier"] as const;

export const collectionsMetric: AgentMetric = {
  agent_key: "collections",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    const exactScores = EXACT_FIELDS.filter((field) => field in expected).map((field) =>
      exactMatch(field, output[field], expected[field]),
    );
    const rankingScore =
      "ranked_recommendations" in expected
        ? [
            topOneMatch(
              "ranked_recommendations",
              output.ranked_recommendations,
              expected.ranked_recommendations,
            ),
          ]
        : [];
    return [...exactScores, ...rankingScore];
  },
};

export const metricRegistry: Readonly<Record<string, AgentMetric>> = {
  collections: collectionsMetric,
};

function exactMatch(field: string, actual: unknown, expected: unknown): EvalFieldScore {
  const passed = Object.is(actual, expected);
  return {
    field,
    expected,
    actual,
    score: passed ? 1 : 0,
    passed,
  };
}

function topOneMatch(field: string, actual: unknown, expected: unknown): EvalFieldScore {
  const actualTop = Array.isArray(actual) ? actual[0] : null;
  const expectedTop = Array.isArray(expected) ? expected[0] : null;
  const passed = expectedTop !== null && Object.is(actualTop, expectedTop);
  return {
    field: `${field}.top1`,
    expected: expectedTop,
    actual: actualTop,
    score: passed ? 1 : 0,
    passed,
  };
}
