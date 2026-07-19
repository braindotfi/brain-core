import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import type { ProposedAction } from "../handler.js";
import { complianceDefinition } from "./definition.js";
import { complianceHandler } from "./handler.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "policy_decision", ref: "pd_1", confidence: 1 },
    { kind: "audit_event", ref: "evt_1", confidence: 1 },
  ],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("complianceHandler", () => {
  it("classifies a missing approval as a notify-only compliance finding", () => {
    const proposed = complianceHandler.build({
      action: "escalate",
      context: {
        finding_type: "approval_missing",
        severity: "medium",
        policy_decision_id: "pd_1",
        audit_event_id: "evt_1",
        payment_intent_id: "pi_1",
      },
      evidence,
      definition: complianceDefinition,
      confidence: 0.95,
    });

    expect(agentAction(proposed)).toMatchObject({
      type: "escalate",
      agent_kind: "compliance",
      finding_kind: "approval_missing",
      finding_type: "approval_missing",
      severity: "medium",
      risk_band: "elevated",
      recommended_remediation:
        "Hold the movement and collect a valid approval before execution continues.",
      mode: "notify_only",
      evidence_refs: [
        { kind: "policy_decision", ref: "pd_1" },
        { kind: "audit_event", ref: "evt_1" },
      ],
    });
    expect(agentAction(proposed).affected_entities).toEqual(
      expect.arrayContaining([
        { kind: "policy_decision", ref: "pd_1" },
        { kind: "audit_event", ref: "evt_1" },
        { kind: "payment_intent", ref: "pi_1" },
      ]),
    );
  });

  it("classifies policy rejects as policy violations", () => {
    const proposed = complianceHandler.build({
      action: "notify",
      context: {
        policy_outcome: "reject",
        policy_decision_id: "pd_2",
        audit_event_id: "evt_2",
      },
      evidence: evidenceFor("pd_2", "evt_2"),
      definition: complianceDefinition,
      confidence: 0.9,
    });

    expect(agentAction(proposed)).toMatchObject({
      finding_kind: "policy_violation",
      severity: "high",
      risk_band: "high",
      mode: "notify_only",
    });
  });

  it("classifies audit gap records as critical findings", () => {
    const proposed = complianceHandler.build({
      action: "create_compliance_report",
      context: {
        audit_gap_detected: true,
        policy_decision_id: "pd_3",
        audit_event_id: "evt_3",
      },
      evidence: evidenceFor("pd_3", "evt_3"),
      definition: complianceDefinition,
      confidence: 0.9,
    });

    expect(agentAction(proposed)).toMatchObject({
      finding_kind: "audit_gap_detected",
      severity: "critical",
      risk_band: "high",
      mode: "notify_only",
    });
  });

  it("emits no_finding for a compliant labeled record", () => {
    const proposed = complianceHandler.build({
      action: "notify",
      context: {
        finding_type: "no_finding",
        policy_decision_id: "pd_4",
        audit_event_id: "evt_4",
      },
      evidence: evidenceFor("pd_4", "evt_4"),
      definition: complianceDefinition,
      confidence: 0.9,
    });

    expect(agentAction(proposed)).toMatchObject({
      type: "notify",
      finding_kind: "no_finding",
      severity: "info",
      risk_band: "standard",
      recommended_remediation: "No remediation required.",
      mode: "notify_only",
    });
  });

  it("fails closed when required policy or audit evidence is missing", () => {
    expect(() =>
      complianceHandler.build({
        action: "notify",
        context: {
          policy_decision_id: "pd_5",
          audit_event_id: "evt_5",
        },
        evidence: {
          items: [{ kind: "policy_decision", ref: "pd_5", confidence: 1 }],
          completeness: 0.5,
          evidence_score: 0.5,
          missing_required_evidence: ["audit_event"],
          critical_missing: true,
        },
        definition: complianceDefinition,
      }),
    ).toThrow("compliance_required_evidence_missing");
  });
});

function evidenceFor(policyDecisionId: string, auditEventId: string): EvidenceBundle {
  return {
    ...evidence,
    items: [
      { kind: "policy_decision", ref: policyDecisionId, confidence: 1 },
      { kind: "audit_event", ref: auditEventId, confidence: 1 },
    ],
  };
}

function agentAction(proposed: ProposedAction): Record<string, unknown> {
  expect(proposed.channel).toBe("agent");
  if (proposed.channel !== "agent") throw new Error("expected agent proposal");
  return proposed.action;
}
