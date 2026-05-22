/**
 * Execution-mode resolution.
 *
 * The protocol decision stays ALLOW | ESCALATE | DENY (see actions-api.md and
 * services/execution/src/actions/mapper.ts). `execution_mode` is an ADDITIVE
 * refinement that folds in the proposing agent's confidence, evidence
 * completeness, and risk level. Existing callers that read `decision === "ALLOW"`
 * are unaffected.
 *
 * Mapping (per Phase 1 spec):
 *   - DENY                                            -> "reject"   (hard stop)
 *   - confidence < minimum OR evidence incomplete     -> "notify_only"
 *   - ESCALATE                                        -> "confirm"
 *   - ALLOW + high confidence + low risk              -> "execute"
 *   - ALLOW otherwise (medium confidence or risk)     -> "propose"
 *
 * DENY precedes notify_only: a hard policy rejection is never downgraded to a
 * passive notification.
 */

export type DecisionVerdict = "ALLOW" | "ESCALATE" | "DENY";

export type ExecutionMode = "execute" | "propose" | "confirm" | "notify_only" | "reject";

export interface ExecutionModeInput {
  readonly decision: DecisionVerdict;
  readonly confidence: number;
  readonly evidenceComplete: boolean;
  readonly minimumConfidence: number;
  readonly riskLevel: "low" | "medium" | "high";
  /** Confidence at/above this counts as "high". Default 0.85. */
  readonly highConfidenceThreshold?: number;
}

export function resolveExecutionMode(input: ExecutionModeInput): ExecutionMode {
  const { decision, confidence, evidenceComplete, minimumConfidence, riskLevel } = input;
  const highConfidenceThreshold = input.highConfidenceThreshold ?? 0.85;

  if (decision === "DENY") {
    return "reject";
  }
  if (confidence < minimumConfidence || !evidenceComplete) {
    return "notify_only";
  }
  if (decision === "ESCALATE") {
    return "confirm";
  }
  if (confidence >= highConfidenceThreshold && riskLevel === "low") {
    return "execute";
  }
  return "propose";
}
