import { describe, expect, it } from "vitest";
import { toAgentRunSummary, toAgentRunWhy, toSummaryStatus } from "./agent-run-views.js";

const baseRun = {
  id: "agnr_1",
  tenant_id: "tnt_x",
  agent_id: "agent_pay",
  status: "executed",
  event_type: "invoice.received",
  intent: undefined,
  action: "pay_invoice",
  confidence: 0.9,
  evidence_score: 0.8,
  payment_intent_id: "pi_1",
  routing_decision_id: "agrd_1",
  reason: { risk_level: "medium", agent_key: "payment", evidence_count: 3 },
  failure_reason: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  completed_at: new Date("2026-01-01T00:01:00Z"),
};

describe("toSummaryStatus", () => {
  it("collapses the wide run vocabulary onto 4 outcomes", () => {
    expect(toSummaryStatus("executed")).toBe("completed");
    expect(toSummaryStatus("proposal_created")).toBe("completed");
    expect(toSummaryStatus("notify_only")).toBe("completed");
    expect(toSummaryStatus("rejected")).toBe("rejected");
    expect(toSummaryStatus("shadow_completed")).toBe("shadow_completed");
    expect(toSummaryStatus("failed")).toBe("failed");
    expect(toSummaryStatus("missing_evidence")).toBe("failed");
    expect(toSummaryStatus("no_match")).toBe("failed");
  });
});

describe("toAgentRunSummary", () => {
  it("maps a completed run with all fields", () => {
    const s = toAgentRunSummary(baseRun, { evidenceCount: 3 });
    expect(s.run_id).toBe("agnr_1");
    expect(s.agent_key).toBe("payment");
    expect(s.status).toBe("completed");
    expect(s.trigger).toEqual({ kind: "invoice.received" });
    expect(s.resolved_action).toEqual({ type: "pay_invoice", source: "event_map" });
    expect(s.evidence_count).toBe(3);
    expect(s.confidence).toBe(0.9);
    expect(s.risk_level).toBe("medium");
    expect(s.outcome).toEqual({ kind: "executed", payment_intent_id: "pi_1" });
    expect(s.started_at).toBe("2026-01-01T00:00:00.000Z");
    expect(s.completed_at).toBe("2026-01-01T00:01:00.000Z");
  });

  it("marks resolved_action explicit when an intent drove the run", () => {
    const s = toAgentRunSummary({ ...baseRun, event_type: undefined, intent: "pay_invoice" });
    expect(s.resolved_action.source).toBe("explicit");
    expect(s.trigger.kind).toBe("pay_invoice");
  });

  it("defaults risk_level to low and evidence_count to 0 when absent", () => {
    const s = toAgentRunSummary({ ...baseRun, reason: {} });
    expect(s.risk_level).toBe("low");
    expect(s.evidence_count).toBe(0);
  });

  it("surfaces a failure reason on failed runs", () => {
    const s = toAgentRunSummary({ ...baseRun, status: "failed", failure_reason: "rail down" });
    expect(s.status).toBe("failed");
    expect(s.outcome.reason).toBe("rail down");
  });

  it("reports a shadow run", () => {
    const s = toAgentRunSummary({ ...baseRun, status: "shadow_completed" });
    expect(s.status).toBe("shadow_completed");
  });
});

describe("toAgentRunWhy", () => {
  it("joins the routing decision candidates + behavior hash", () => {
    const why = toAgentRunWhy(
      baseRun,
      {
        selected_agent_id: "agent_pay",
        fallback_agent_ids: ["agent_alt"],
        reason: { score: 0.9, evidence_completeness: 1, reputation: 0.7, cost: 0.1 },
      },
      "0xbehavior",
    );
    expect(why.run_id).toBe("agnr_1");
    expect(why.selected_agent_id).toBe("agent_pay");
    expect(why.candidate_agent_ids).toEqual(["agent_pay", "agent_alt"]);
    expect(why.reason.score).toBe(0.9);
    expect(why.behavior_hash).toBe("0xbehavior");
  });

  it("falls back to the run's agent + reason when no routing decision", () => {
    const why = toAgentRunWhy(baseRun, null, null);
    expect(why.selected_agent_id).toBe("agent_pay");
    expect(why.candidate_agent_ids).toEqual(["agent_pay"]);
    expect(why.behavior_hash).toBeNull();
  });
});
