import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";
import { BrainAPIError } from "./errors.js";

function mockSequence(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof globalThis.fetch;
  calls: Request[];
} {
  const calls: Request[] = [];
  let i = 0;
  const fn = vi.fn(async (input: Request | URL | string) => {
    calls.push(input as Request);
    const r = responses[i++];
    if (!r) throw new Error("ran out of mocked responses");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("Brain.proposals", () => {
  it("list fetches summaries with query filters", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          proposals: [
            {
              id: "agpr_1",
              type: "vendor_risk",
              agent_principal: "agent_1",
              risk_band: "elevated",
              status: "needs_review",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const proposals = await brain.proposals.list({ status: "needs_review", type: "vendor_risk" });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe("agpr_1");
    expect(calls[0]?.url).toContain("/proposals?");
    expect(calls[0]?.url).toContain("status=needs_review");
    expect(calls[0]?.url).toContain("type=vendor_risk");
  });

  it("list returns an empty array when the server omits proposals", async () => {
    const { fetch } = mockSequence([{ status: 200, body: {} }]);
    const brain = new Brain({ token: "k", fetch });

    const proposals = await brain.proposals.list();

    expect(proposals).toEqual([]);
  });

  it("get fetches by id", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          id: "agpr_1",
          type: "treasury",
          agent_principal: "agent_1",
          risk_band: "low",
          status: "approved",
          created_at: "2026-01-01T00:00:00Z",
          execution_mode: "propose",
          narrative: "swept idle cash",
          evidence: [],
          links: {},
          reversible: true,
          decision: "approved",
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const proposal = await brain.proposals.get("agpr_1");

    expect(proposal.id).toBe("agpr_1");
    expect(calls[0]?.url).toContain("/proposals/agpr_1");
  });

  it("decide posts the decision body", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          id: "agpr_1",
          type: "collections",
          agent_principal: "agent_1",
          risk_band: "standard",
          status: "approved",
          created_at: "2026-01-01T00:00:00Z",
          decision: "approved",
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const proposal = await brain.proposals.decide("agpr_1", { decision: "approved" });

    expect(proposal.status).toBe("approved");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/proposals/agpr_1/decide");
    const sentBody = await calls[0]!.text();
    expect(sentBody).toContain('"decision":"approved"');
  });

  it("decide propagates HTTP errors (e.g. an illegal transition)", async () => {
    const { fetch } = mockSequence([
      {
        status: 409,
        body: { error: { code: "agent_proposal_invalid_state", message: "invalid transition" } },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.proposals.decide("agpr_1", { decision: "approved" })).rejects.toBeInstanceOf(
      BrainAPIError,
    );
  });
});
