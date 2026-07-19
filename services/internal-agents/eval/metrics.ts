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

export const reconciliationMetric: AgentMetric = {
  agent_key: "reconciliation",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    const expectedMatches = readExpectedMatches(expected.expected_matches);
    const actualMatches = readActualMatches(output);
    const precision = precisionScore(actualMatches, expectedMatches);
    const recall = recallScore(actualMatches, expectedMatches);
    return [
      {
        field: "matching.precision",
        expected: expectedMatches,
        actual: actualMatches,
        score: precision,
        passed: precision === 1,
      },
      {
        field: "matching.recall",
        expected: expectedMatches,
        actual: actualMatches,
        score: recall,
        passed: recall === 1,
      },
    ];
  },
};

export const metricRegistry: Readonly<Record<string, AgentMetric>> = {
  collections: collectionsMetric,
  reconciliation: reconciliationMetric,
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

interface ExpectedMatch {
  readonly left_entity_id: string;
  readonly right_entity_id: string;
}

function readExpectedMatches(raw: unknown): readonly ExpectedMatch[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const row = item as Record<string, unknown>;
      return typeof row.left_entity_id === "string" && typeof row.right_entity_id === "string"
        ? { left_entity_id: row.left_entity_id, right_entity_id: row.right_entity_id }
        : null;
    })
    .filter((item): item is ExpectedMatch => item !== null);
}

function readActualMatches(output: Record<string, unknown>): readonly ExpectedMatch[] {
  if (
    output.match_type !== "propose_match" ||
    typeof output.left_entity_id !== "string" ||
    typeof output.right_entity_id !== "string"
  ) {
    return [];
  }
  return [{ left_entity_id: output.left_entity_id, right_entity_id: output.right_entity_id }];
}

function precisionScore(
  actualMatches: readonly ExpectedMatch[],
  expectedMatches: readonly ExpectedMatch[],
): number {
  if (actualMatches.length === 0) return expectedMatches.length === 0 ? 1 : 0;
  const expected = new Set(expectedMatches.map(matchKey));
  const truePositive = actualMatches.filter((match) => expected.has(matchKey(match))).length;
  return truePositive / actualMatches.length;
}

function recallScore(
  actualMatches: readonly ExpectedMatch[],
  expectedMatches: readonly ExpectedMatch[],
): number {
  if (expectedMatches.length === 0) return actualMatches.length === 0 ? 1 : 0;
  const actual = new Set(actualMatches.map(matchKey));
  const truePositive = expectedMatches.filter((match) => actual.has(matchKey(match))).length;
  return truePositive / expectedMatches.length;
}

function matchKey(match: ExpectedMatch): string {
  return `${match.left_entity_id}->${match.right_entity_id}`;
}
