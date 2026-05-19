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

const ACTION = {
  type: "outbound_payment" as const,
  counterparty: "cp_1",
  amount: { currency: "USD", value: 100 },
  rail: "bank_ach" as const,
};

describe("Brain.actions", () => {
  it("propose posts agent_id, action, and idempotency_key (body + header)", async () => {
    const { fetch, calls } = mockFetch(201, {
      id: "prop_1",
      status: "pending",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const proposal = await brain.actions.propose({
      agentId: "agent_1",
      action: ACTION,
      idempotencyKey: "idem-1",
    });

    expect(proposal.id).toBe("prop_1");
    const request = calls[0]!;
    expect(request.headers.get("idempotency-key")).toBe("idem-1");
    const sent = await request.text();
    expect(sent).toContain('"agent_id":"agent_1"');
    expect(sent).toContain('"idempotency_key":"idem-1"');
  });

  it("propose omits idempotency_key when not provided", async () => {
    const { fetch, calls } = mockFetch(201, { id: "prop_1" });
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.actions.propose({ agentId: "agent_1", action: ACTION });

    const sent = await calls[0]!.text();
    expect(sent).not.toContain("idempotency_key");
    expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
  });

  it("execute returns startedExecution with dryRun forwarded", async () => {
    const { fetch, calls } = mockFetch(202, {
      execution_id: "ex_1",
      status: "started",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.actions.execute({
      proposalId: "prop_1",
      dryRun: true,
    });

    expect(result).toEqual({ executionId: "ex_1", status: "started" });
    const sent = await calls[0]!.text();
    expect(sent).toContain('"dry_run":true');
  });

  it("execute omits dry_run when not provided", async () => {
    const { fetch, calls } = mockFetch(202, {
      execution_id: "ex_1",
      status: "started",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.actions.execute({ proposalId: "prop_1" });

    const sent = await calls[0]!.text();
    expect(sent).not.toContain("dry_run");
  });

  it("approve forwards approver_notes when provided", async () => {
    const { fetch, calls } = mockFetch(200, {
      id: "prop_1",
      status: "approved",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.actions.approve({
      proposalId: "prop_1",
      approverNotes: "ok",
    });

    const sent = await calls[0]!.text();
    expect(sent).toContain("approver_notes");
    expect(sent).toContain('"ok"');
  });

  it("escalate posts proposal_id and reason", async () => {
    const { fetch, calls } = mockFetch(200, {});
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.actions.escalate({
      proposalId: "prop_1",
      reason: "needs human",
    });

    const sent = await calls[0]!.text();
    expect(sent).toContain('"proposal_id":"prop_1"');
    expect(sent).toContain("needs human");
  });

  it("get fetches execution by id", async () => {
    const { fetch, calls } = mockFetch(200, {
      id: "ex_1",
      status: "succeeded",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const execution = await brain.actions.get("ex_1");

    expect(execution.id).toBe("ex_1");
    expect(calls[0]?.url).toContain("/execution/ex_1");
  });
});
