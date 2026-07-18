import type { EvidenceBundle } from "../src/evidence.js";
import type { HandlerInput, InternalAgentHandler } from "../src/handler.js";

export type EvalExpectedFields = Readonly<Record<string, unknown>>;

export interface GoldenScenario {
  readonly agent_key: string;
  readonly name: string;
  readonly rationale: string;
  readonly input: {
    readonly action: string;
    readonly context: Record<string, unknown>;
    readonly evidence: EvidenceBundle;
  };
  readonly expected: EvalExpectedFields;
  readonly expect_fail_closed?: boolean;
}

export interface EvalFieldScore {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly score: number;
  readonly passed: boolean;
}

export interface EvalScenarioResult {
  readonly agent_key: string;
  readonly name: string;
  readonly passed: boolean;
  readonly fail_closed: boolean;
  readonly error_code: string | null;
  readonly fields: readonly EvalFieldScore[];
  readonly score: number;
}

export interface EvalAgentAggregate {
  readonly agent_key: string;
  readonly scenario_count: number;
  readonly passed_count: number;
  readonly score: number;
  readonly field_accuracy: Readonly<Record<string, number>>;
}

export interface GoldenEvalReport {
  readonly generated_at: string;
  readonly fixed_clock: string;
  readonly scenarios: readonly EvalScenarioResult[];
  readonly aggregate: Readonly<Record<string, EvalAgentAggregate>>;
}

export interface AgentMetric {
  readonly agent_key: string;
  score(output: Record<string, unknown>, expected: EvalExpectedFields): readonly EvalFieldScore[];
}

export interface GoldenEvalDeps {
  readonly handlers: Readonly<Record<string, InternalAgentHandler>>;
  readonly metrics: Readonly<Record<string, AgentMetric>>;
  readonly scenarios: readonly GoldenScenario[];
  readonly fixedClock: Date;
  readonly generatedAt?: string;
}

export interface BaselineAgentScore {
  readonly minimum_score: number;
  readonly scenario_count: number;
}

export interface GoldenEvalBaseline {
  readonly version: number;
  readonly fixed_clock: string;
  readonly agents: Readonly<Record<string, BaselineAgentScore>>;
}

export interface BaselineComparison {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export function inputForScenario(scenario: GoldenScenario, fixedClock: Date): HandlerInput {
  return {
    action: scenario.input.action,
    context: scenario.input.context,
    evidence: scenario.input.evidence,
    now: fixedClock,
  };
}
