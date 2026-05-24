import { describe, expect, it, vi } from "vitest";
import { Brain } from "./brain.js";

function mockFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fn = vi.fn(async (input: Request | URL | string) => {
    calls.push(input as Request);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("Brain.agentRuns (H-25)", () => {
  it("get returns the run summary", async () => {
    const { fetch, calls } = mockFetch(200, {
      run_id: "agnr_1",
      tenant_id: "tnt_x",
      agent_id: "agent_pay",
      agent_key: "payment",
      status: "completed",
      trigger: { kind: "invoice.received" },
      resolved_action: { type: "pay_invoice", source: "event_map" },
      evidence_count: 2,
      confidence: 0.9,
      evidence_score: 0.8,
      risk_level: "medium",
      outcome: { kind: "executed", payment_intent_id: "pi_1" },
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z",
    });
    const brain = new Brain({ token: "k", fetch });
    const summary = await brain.agentRuns.get("agnr_1");
    expect(summary.status).toBe("completed");
    expect(summary.outcome.payment_intent_id).toBe("pi_1");
    expect(calls[0]?.url).toContain("/agents/runs/agnr_1");
  });

  it("why returns candidates + behavior hash", async () => {
    const { fetch, calls } = mockFetch(200, {
      run_id: "agnr_1",
      selected_agent_id: "agent_pay",
      candidate_agent_ids: ["agent_pay", "agent_alt"],
      reason: { score: 0.9 },
      behavior_hash: "0xb",
    });
    const brain = new Brain({ token: "k", fetch });
    const why = await brain.agentRuns.why("agnr_1");
    expect(why.candidate_agent_ids).toEqual(["agent_pay", "agent_alt"]);
    expect(calls[0]?.url).toContain("/agents/runs/agnr_1/why");
  });

  it("evidence returns the chain", async () => {
    const { fetch, calls } = mockFetch(200, {
      run_id: "agnr_1",
      evidence: [{ id: "agev_1", kind: "invoice", ref: "inv_1", stale: false }],
    });
    const brain = new Brain({ token: "k", fetch });
    const { evidence } = await brain.agentRuns.evidence("agnr_1");
    expect(evidence[0]?.kind).toBe("invoice");
    expect(calls[0]?.url).toContain("/agents/runs/agnr_1/evidence");
  });

  it("gateTrace returns the §6 checks", async () => {
    const { fetch, calls } = mockFetch(200, {
      run_id: "agnr_1",
      payment_intent_id: "pi_1",
      gate_checks: [{ index: 1, name: "agent_identity_verified", passed: true }],
    });
    const brain = new Brain({ token: "k", fetch });
    const trace = await brain.agentRuns.gateTrace("agnr_1");
    expect(trace.gate_checks[0]?.passed).toBe(true);
    expect(calls[0]?.url).toContain("/agents/runs/agnr_1/gate-trace");
  });

  it("proof proxies the H-07 proof", async () => {
    const { fetch, calls } = mockFetch(200, { action_id: "pi_1", outcome: "executed" });
    const brain = new Brain({ token: "k", fetch });
    const proof = await brain.agentRuns.proof("agnr_1");
    expect(proof.action_id).toBe("pi_1");
    expect(calls[0]?.url).toContain("/agents/runs/agnr_1/proof");
  });

  it("propagates 404 (run not found / not visible)", async () => {
    const { fetch } = mockFetch(404, { code: "agent_run_not_found", message: "no run" });
    const brain = new Brain({ token: "k", fetch });
    await expect(brain.agentRuns.get("missing")).rejects.toMatchObject({ status: 404 });
  });
});
