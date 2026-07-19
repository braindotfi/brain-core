import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

type FindingType = "approval_missing" | "policy_violation" | "audit_gap_detected" | "no_finding";
type Severity = "info" | "medium" | "high" | "critical";

interface ComplianceFinding {
  readonly findingType: FindingType;
  readonly severity: Severity;
  readonly ruleId: string;
  readonly recommendedRemediation: string;
}

export const complianceHandler: InternalAgentHandler = {
  agent_key: "compliance",
  actions: ["notify", "escalate", "block_action", "create_compliance_report"],
  build(input: HandlerInput): ProposedAction {
    return buildComplianceProposal(input);
  },
};

function buildComplianceProposal(input: HandlerInput): ProposedAction {
  requireEvidence(input);
  const policyDecisionId = readString(input.context.policy_decision_id);
  const auditEventId = readString(input.context.audit_event_id);
  const finding = classifyFinding(input);
  const refs = affectedEntities(input, policyDecisionId, auditEventId);

  return {
    channel: "agent",
    action: {
      type: finding.findingType === "no_finding" ? "notify" : input.action,
      kind: "agent_action",
      agent_kind: "compliance",
      rule_id: finding.ruleId,
      finding_kind: finding.findingType,
      finding_type: finding.findingType,
      severity: finding.severity,
      risk_band: riskBandFor(finding.severity),
      affected_entities: refs,
      offending_record_refs: refs,
      policy_decision_id: policyDecisionId,
      audit_event_id: auditEventId,
      payment_intent_id: readString(input.context.payment_intent_id) || null,
      recommended_remediation: finding.recommendedRemediation,
      narrative: narrativeFor(finding, input),
      summary: summaryFor(finding),
      confidence: policyConfidenceForEvidence(input.evidence, input.confidence),
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? "high",
      agent_id: input.definition?.agent_key ?? "compliance",
      agent_role: input.definition?.agent_key ?? "compliance",
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: "notify_only",
    },
  };
}

function requireEvidence(input: HandlerInput): void {
  const kinds = new Set(input.evidence.items.map((item) => item.kind));
  if (
    input.evidence.critical_missing ||
    input.evidence.missing_required_evidence.length > 0 ||
    !kinds.has("policy_decision") ||
    !kinds.has("audit_event")
  ) {
    throw new Error("compliance_required_evidence_missing");
  }
}

function classifyFinding(input: HandlerInput): ComplianceFinding {
  const explicit = readString(input.context.finding_type);
  if (explicit === "approval_missing") {
    return {
      findingType: "approval_missing",
      severity: severityFrom(input, "medium"),
      ruleId: readString(input.context.rule_id, "cmp_missing_approval"),
      recommendedRemediation:
        "Hold the movement and collect a valid approval before execution continues.",
    };
  }
  if (explicit === "policy_violation" || readString(input.context.policy_outcome) === "reject") {
    return {
      findingType: "policy_violation",
      severity: severityFrom(input, "high"),
      ruleId: readString(input.context.rule_id, "cmp_policy_violation"),
      recommendedRemediation: "Review the rejected policy decision and keep the action blocked.",
    };
  }
  if (explicit === "audit_gap_detected" || readBoolean(input.context.audit_gap_detected)) {
    return {
      findingType: "audit_gap_detected",
      severity: severityFrom(input, "critical"),
      ruleId: readString(input.context.rule_id, "cmp_audit_gap"),
      recommendedRemediation: "Pause dependent workflows and reconcile the audit chain gap.",
    };
  }
  return {
    findingType: "no_finding",
    severity: "info",
    ruleId: readString(input.context.rule_id, "cmp_no_finding"),
    recommendedRemediation: "No remediation required.",
  };
}

function affectedEntities(
  input: HandlerInput,
  policyDecisionId: string,
  auditEventId: string,
): Array<{ kind: string; ref: string }> {
  const entities = [
    { kind: "policy_decision", ref: policyDecisionId },
    { kind: "audit_event", ref: auditEventId },
  ];
  const paymentIntentId = readString(input.context.payment_intent_id);
  if (paymentIntentId.length > 0) {
    entities.push({ kind: "payment_intent", ref: paymentIntentId });
  }
  const approvalId = readString(input.context.approval_id);
  if (approvalId.length > 0) {
    entities.push({ kind: "approval", ref: approvalId });
  }
  return entities;
}

function narrativeFor(finding: ComplianceFinding, input: HandlerInput): string {
  const subject =
    readString(input.context.subject_id) || readString(input.context.payment_intent_id);
  const target = subject.length > 0 ? ` for ${subject}` : "";
  if (finding.findingType === "no_finding") {
    return `Compliance review${target} found no labeled governance gap.`;
  }
  return (
    `Compliance review${target} found ${finding.findingType} with ` +
    `${finding.severity} severity. ${finding.recommendedRemediation}`
  );
}

function summaryFor(finding: ComplianceFinding): string {
  return `Compliance finding ${finding.findingType} severity ${finding.severity}.`;
}

function severityFrom(input: HandlerInput, fallback: Severity): Severity {
  const raw = readString(input.context.severity);
  return raw === "info" || raw === "medium" || raw === "high" || raw === "critical"
    ? raw
    : fallback;
}

function riskBandFor(severity: Severity): "standard" | "elevated" | "high" {
  if (severity === "critical" || severity === "high") return "high";
  if (severity === "medium") return "elevated";
  return "standard";
}

function readBoolean(value: unknown): boolean {
  return value === true || value === "true";
}
