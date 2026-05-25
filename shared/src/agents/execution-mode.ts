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

import type { AgentOutput } from "../contracts/agent-output.js";

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

/**
 * H-16: resolve an execution mode directly from a canonical AgentOutput. The
 * agent's `suggested_execution_mode` is the ceiling; it is downgraded when
 * confidence is below the floor, evidence is missing, or risk is elevated.
 * `critical`/`high` risk never resolves above `confirm`; any missing evidence
 * forces `notify_only`. This is the AgentOutput-shaped entry point the spec asks
 * the resolver to consume.
 */
export function resolveExecutionModeFromOutput(
  output: AgentOutput,
  opts: { minimumConfidence: number; highConfidenceThreshold?: number } = {
    minimumConfidence: 0.7,
  },
): ExecutionMode {
  const high = opts.highConfidenceThreshold ?? 0.85;

  if (output.missing_evidence.length > 0 || output.confidence < opts.minimumConfidence) {
    return "notify_only";
  }
  // The agent's own suggestion is the starting ceiling.
  let mode: ExecutionMode = output.suggested_execution_mode;
  // Elevated risk caps at confirm.
  if (output.risk_level === "high" || output.risk_level === "critical") {
    mode = capAutonomy(mode, "confirm");
  }
  // `execute` requires high confidence + low risk; otherwise downgrade to propose.
  if (mode === "execute" && !(output.confidence >= high && output.risk_level === "low")) {
    mode = "propose";
  }
  return mode;
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

// ---------------------------------------------------------------------------
// Final execution-mode resolver (Agent Autonomy v3, 1b.4)
// ---------------------------------------------------------------------------

/** Authority levels an agent/tenant may hold. Mirrors @brain/schemas AgentAuthority. */
export type Authority = "execute" | "propose" | "notify_only";

/** Policy outcome from the §6 gate (live or dry-run). */
export type GateOutcomeInput = "allow" | "confirm" | "reject";

export type CounterpartyRisk = "low" | "medium" | "high" | "sanctioned";

export interface FinalExecutionModeInput {
  /** Router/agent-suggested mode (typically from resolveExecutionMode). */
  readonly suggestedMode: ExecutionMode;
  /** The agent definition's default_authority — a hard cap on the result. */
  readonly agentDefaultAuthority: Authority;
  /** The tenant policy template's authority cap, if any. */
  readonly tenantAuthorityCap?: Authority;
  /** Gate dry-run outcome; null when no gate ran (non-financial actions). */
  readonly gateDryRunOutcome: GateOutcomeInput | null;
  readonly evidenceComplete: boolean;
  readonly criticalMissing: boolean;
  /** What to do when required evidence is missing (per agent definition). */
  readonly missingEvidenceBehavior?: "notify_only" | "reject";
  readonly confidence: number;
  readonly highConfidenceThreshold?: number;
  readonly riskLevel: "low" | "medium" | "high";
  readonly counterpartyRisk?: CounterpartyRisk | null;
  readonly actionKind: "financial" | "non_financial";
  /** Phase 2.3 behaviorHash pin. false ⇒ runtime hash ≠ registered ⇒ hard reject. */
  readonly behaviorHashMatches?: boolean;
}

/** Autonomy ranking — higher is more autonomous. */
const AUTONOMY: Record<ExecutionMode, number> = {
  reject: 0,
  notify_only: 1,
  confirm: 2,
  propose: 3,
  execute: 4,
};

function authorityToMode(authority: Authority): ExecutionMode {
  return authority; // execute|propose|notify_only are all valid ExecutionMode values
}

/** Return the LESS autonomous of two modes (a ceiling/cap). */
function capAutonomy(mode: ExecutionMode, cap: ExecutionMode): ExecutionMode {
  return AUTONOMY[mode] <= AUTONOMY[cap] ? mode : cap;
}

/**
 * Resolve the final execution mode by applying every hard constraint in order
 * (1b.4). Each rule can only make the result MORE restrictive. `execute` is
 * reachable only when every precondition is satisfied. INV-4: a high-risk agent
 * never resolves above `confirm`.
 *
 * Note: a `financial` action that resolves to `execute` still runs the live §6
 * gate at execute time — "execute" means "auto-approved through the gate", never
 * "skip the gate" (INV-1).
 */
export function resolveFinalExecutionMode(input: FinalExecutionModeInput): ExecutionMode {
  const high = input.highConfidenceThreshold ?? 0.85;

  // 1 — behaviorHash mismatch → hard reject.
  if (input.behaviorHashMatches === false) {
    return "reject";
  }
  // 2 — gate dry-run reject → reject.
  if (input.gateDryRunOutcome === "reject") {
    return "reject";
  }
  // 3 — critical missing evidence → notify_only or reject (per agent definition).
  if (input.criticalMissing) {
    return input.missingEvidenceBehavior === "reject" ? "reject" : "notify_only";
  }

  let mode = input.suggestedMode;

  // 5 — high-risk agent caps at confirm (INV-4).
  if (input.riskLevel === "high") {
    mode = capAutonomy(mode, "confirm");
  }
  // 6 — risky counterparty → at least confirm.
  if (input.counterpartyRisk === "high" || input.counterpartyRisk === "sanctioned") {
    mode = capAutonomy(mode, "confirm");
  }
  // gate dry-run confirm → at least confirm.
  if (input.gateDryRunOutcome === "confirm") {
    mode = capAutonomy(mode, "confirm");
  }
  // 7 — tenant authority cap.
  if (input.tenantAuthorityCap !== undefined) {
    mode = capAutonomy(mode, authorityToMode(input.tenantAuthorityCap));
  }
  // 8 — agent default_authority caps the result.
  mode = capAutonomy(mode, authorityToMode(input.agentDefaultAuthority));

  // 9 — execute is reachable only if every precondition holds.
  if (mode === "execute") {
    const eligible =
      input.gateDryRunOutcome === "allow" &&
      input.evidenceComplete &&
      input.confidence >= high &&
      input.riskLevel === "low" &&
      (input.counterpartyRisk == null || input.counterpartyRisk === "low");
    if (!eligible) {
      mode = "propose";
    }
  }

  return mode;
}
