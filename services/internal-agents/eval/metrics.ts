import type { AgentMetric, EvalExpectedFields, EvalFieldScore } from "./types.js";

const EXACT_FIELDS = ["recommended_action", "escalation_tier", "aging_tier"] as const;
const CASH_FORECAST_NUMERIC_TOLERANCE = 0.01;
const REVENUE_NUMERIC_TOLERANCE = 0.01;
const TREASURY_NUMERIC_TOLERANCE = 0.01;

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

export const cashForecastMetric: AgentMetric = {
  agent_key: "cash_forecast",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    const numericScores = readExpectedNumbers(expected.projected_net_position).map(
      ([field, expectedValue]) =>
        numericWithinTolerance(
          `projected_net_position.${field}`,
          readNestedNumber(output.projected_net_position, field),
          expectedValue,
          CASH_FORECAST_NUMERIC_TOLERANCE,
        ),
    );
    const minBalanceScore =
      "min_projected_balance" in expected
        ? [
            numericWithinTolerance(
              "min_projected_balance",
              numberValue(output.min_projected_balance),
              numberValue(expected.min_projected_balance),
              CASH_FORECAST_NUMERIC_TOLERANCE,
            ),
          ]
        : [];
    const mae = meanAbsoluteError(
      numericScores
        .map((score) => ({
          expected: numberValue(score.expected),
          actual: numberValue(score.actual),
        }))
        .filter(
          (row): row is { expected: number; actual: number } =>
            row.expected !== null && row.actual !== null,
        ),
    );
    return [
      ...numericScores,
      ...minBalanceScore,
      {
        field: "projected_net_position.mae",
        expected: 0,
        actual: mae,
        score: mae <= CASH_FORECAST_NUMERIC_TOLERANCE ? 1 : 0,
        passed: mae <= CASH_FORECAST_NUMERIC_TOLERANCE,
      },
      exactMatch("recommended_action", output.recommended_action, expected.recommended_action),
      exactMatch("shortfall_date", output.shortfall_date, expected.shortfall_date),
    ];
  },
};

export const vendorRiskMetric: AgentMetric = {
  agent_key: "vendor_risk",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    const actualHighRisk = output.risk_band === "high" || output.recommended_action === "hold";
    const expectedHighRisk = expected.expected_high_risk === true;
    const expectedRank = numberValue(expected.risk_rank);
    const actualRank = riskRank(output.risk_band);
    return [
      ...classifierScores(actualHighRisk, expectedHighRisk),
      {
        field: "risk_order.rank",
        expected: expectedRank,
        actual: actualRank,
        score: expectedRank !== null && actualRank === expectedRank ? 1 : 0,
        passed: expectedRank !== null && actualRank === expectedRank,
      },
    ];
  },
};

export const fraudAnomalyMetric: AgentMetric = {
  agent_key: "fraud_anomaly",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    const actualAnomaly = readActualFraudFlag(output);
    const expectedAnomaly = expected.expected_anomaly === true;
    const classifier = classifierScores(actualAnomaly, expectedAnomaly);
    const precision = classifier[0]?.score ?? 0;
    const recall = classifier[1]?.score ?? 0;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    const falsePositiveRate = actualAnomaly && !expectedAnomaly ? 1 : 0;
    const expectedType = expected.anomaly_type;
    const actualType = output.anomaly_type;
    return [
      ...classifier,
      {
        field: "classifier.f1",
        expected: 1,
        actual: f1,
        score: f1,
        passed: f1 === 1,
      },
      {
        field: "classifier.false_positive_rate",
        expected: 0,
        actual: falsePositiveRate,
        score: falsePositiveRate === 0 ? 1 : 0,
        passed: falsePositiveRate === 0,
      },
      exactMatch("anomaly_type", actualType, expectedType),
    ];
  },
};

export const complianceMetric: AgentMetric = {
  agent_key: "compliance",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    const actualViolation = readActualComplianceViolation(output);
    const expectedViolation = expected.expected_violation === true;
    return classifierScores(actualViolation, expectedViolation);
  },
};

export const disputeMetric: AgentMetric = {
  agent_key: "dispute",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    return [
      exactMatch("recommended_action", output.recommended_action, expected.recommended_action),
      numericWithinTolerance(
        "evidence_completeness",
        numberValue(output.evidence_completeness),
        numberValue(expected.evidence_completeness),
        REVENUE_NUMERIC_TOLERANCE,
      ),
    ];
  },
};

export const revenueIntelMetric: AgentMetric = {
  agent_key: "revenue_intel",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    const numericScores = [
      numericWithinTolerance(
        "revenue_delta",
        numberValue(output.revenue_delta),
        numberValue(expected.revenue_delta),
        REVENUE_NUMERIC_TOLERANCE,
      ),
      numericWithinTolerance(
        "revenue_delta_percent",
        numberValue(output.revenue_delta_percent),
        numberValue(expected.revenue_delta_percent),
        REVENUE_NUMERIC_TOLERANCE,
      ),
      numericWithinTolerance(
        "dso_delta",
        numberValue(output.dso_delta),
        numberValue(expected.dso_delta),
        REVENUE_NUMERIC_TOLERANCE,
      ),
    ];
    const mae = meanAbsoluteError(
      numericScores
        .map((score) => ({
          expected: numberValue(score.expected),
          actual: numberValue(score.actual),
        }))
        .filter(
          (row): row is { expected: number; actual: number } =>
            row.expected !== null && row.actual !== null,
        ),
    );
    return [
      ...numericScores,
      {
        field: "revenue.mae",
        expected: 0,
        actual: mae,
        score: mae <= REVENUE_NUMERIC_TOLERANCE ? 1 : 0,
        passed: mae <= REVENUE_NUMERIC_TOLERANCE,
      },
      exactMatch("revenue_trend", output.revenue_trend, expected.revenue_trend),
      exactMatch(
        "at_risk_customer_count",
        output.at_risk_customer_count,
        expected.at_risk_customer_count,
      ),
      exactMatch(
        "upcoming_renewal_count",
        output.upcoming_renewal_count,
        expected.upcoming_renewal_count,
      ),
    ];
  },
};

export const subscriptionMetric: AgentMetric = {
  agent_key: "subscription",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    const actualSubscription = output.is_subscription === true;
    const expectedSubscription = expected.expected_subscription === true;
    return [
      ...classifierScores(actualSubscription, expectedSubscription),
      exactMatch("is_subscription", output.is_subscription, expected.expected_subscription),
      exactMatch("recommended_action", output.recommended_action, expected.recommended_action),
      exactMatch("cadence", output.cadence, expected.cadence),
    ];
  },
};

export const treasuryMetric: AgentMetric = {
  agent_key: "treasury",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    return [
      numericWithinTolerance(
        "sweep_amount",
        numberValue(output.sweep_amount),
        numberValue(expected.sweep_amount),
        TREASURY_NUMERIC_TOLERANCE,
      ),
      exactMatch("recommended_action", output.recommended_action, expected.recommended_action),
    ];
  },
};

export const paymentMetric: AgentMetric = {
  agent_key: "payment",
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[] {
    return [
      exactMatch(
        "recommended_payment_decision",
        output.recommended_payment_decision,
        expected.recommended_payment_decision,
      ),
      topOnePayableMatch(output.ranked_payables, expected.ranked_payables),
    ];
  },
};

export const metricRegistry: Readonly<Record<string, AgentMetric>> = {
  cash_forecast: cashForecastMetric,
  collections: collectionsMetric,
  compliance: complianceMetric,
  dispute: disputeMetric,
  fraud_anomaly: fraudAnomalyMetric,
  payment: paymentMetric,
  reconciliation: reconciliationMetric,
  revenue_intel: revenueIntelMetric,
  subscription: subscriptionMetric,
  treasury: treasuryMetric,
  vendor_risk: vendorRiskMetric,
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

function classifierScores(actualPositive: boolean, expectedPositive: boolean): EvalFieldScore[] {
  const truePositive = actualPositive && expectedPositive ? 1 : 0;
  const falsePositive = actualPositive && !expectedPositive ? 1 : 0;
  const falseNegative = !actualPositive && expectedPositive ? 1 : 0;
  const precision = truePositive + falsePositive === 0 ? (expectedPositive ? 0 : 1) : truePositive;
  const recall = truePositive + falseNegative === 0 ? 1 : truePositive;
  return [
    {
      field: "classifier.precision",
      expected: 1,
      actual: precision,
      score: precision,
      passed: precision === 1,
    },
    {
      field: "classifier.recall",
      expected: 1,
      actual: recall,
      score: recall,
      passed: recall === 1,
    },
  ];
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

function topOnePayableMatch(actual: unknown, expected: unknown): EvalFieldScore {
  const actualTop = readTopObligationId(actual);
  const expectedTop = readTopObligationId(expected);
  const passed = expectedTop !== null && actualTop === expectedTop;
  return {
    field: "ranked_payables.top1",
    expected: expectedTop,
    actual: actualTop,
    score: passed ? 1 : 0,
    passed,
  };
}

function readTopObligationId(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const top = raw[0];
  if (typeof top === "string") return top;
  if (typeof top !== "object" || top === null) return null;
  const id = (top as Record<string, unknown>).obligation_id;
  return typeof id === "string" ? id : null;
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

function readExpectedNumbers(raw: unknown): Array<[string, number]> {
  if (typeof raw !== "object" || raw === null) return [];
  return Object.entries(raw as Record<string, unknown>)
    .map(([key, value]): [string, number] | null => {
      const parsed = numberValue(value);
      return parsed === null ? null : [key, parsed];
    })
    .filter((row): row is [string, number] => row !== null);
}

function readNestedNumber(raw: unknown, key: string): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  return numberValue((raw as Record<string, unknown>)[key]);
}

function numberValue(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numericWithinTolerance(
  field: string,
  actual: number | null,
  expected: number | null,
  tolerance: number,
): EvalFieldScore {
  const delta =
    actual !== null && expected !== null ? Math.abs(actual - expected) : Number.POSITIVE_INFINITY;
  const passed = delta <= tolerance;
  return {
    field,
    expected,
    actual,
    score: passed ? 1 : 0,
    passed,
  };
}

function meanAbsoluteError(rows: readonly { expected: number; actual: number }[]): number {
  if (rows.length === 0) return Number.POSITIVE_INFINITY;
  return rows.reduce((sum, row) => sum + Math.abs(row.actual - row.expected), 0) / rows.length;
}

function riskRank(raw: unknown): number | null {
  if (raw === "high") return 3;
  if (raw === "elevated") return 2;
  if (raw === "standard") return 1;
  return null;
}

function readActualFraudFlag(output: Record<string, unknown>): boolean {
  const score = numberValue(output.anomaly_score) ?? 0;
  return (
    score >= 0.5 || output.recommended_action === "review" || output.recommended_action === "hold"
  );
}

function readActualComplianceViolation(output: Record<string, unknown>): boolean {
  const finding = output.finding_type ?? output.finding_kind;
  return (
    finding === "approval_missing" ||
    finding === "policy_violation" ||
    finding === "audit_gap_detected"
  );
}
