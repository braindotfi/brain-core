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
  it("lists typed proposals with filters", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { proposals: [], next_cursor: null } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const page = await brain.proposals.list({
      type: "vendor_risk",
      status: "acknowledged",
      min_confidence: 0.7,
    });

    expect(page.proposals).toEqual([]);
    expect(calls[0]?.url).toContain("/proposals?");
    expect(calls[0]?.url).toContain("type=vendor_risk");
    expect(calls[0]?.url).toContain("status=acknowledged");
    expect(calls[0]?.url).toContain("min_confidence=0.7");
  });

  it("gets a proposal by id", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          id: "prop_1",
          type: "vendor_risk",
          status: "pending",
          evidence: [],
          payment_intent_id: null,
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const proposal = await brain.proposals.get("prop_1");

    expect(proposal.id).toBe("prop_1");
    expect(calls[0]?.url).toContain("/proposals/prop_1");
  });

  it("posts a decision", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          id: "prop_1",
          decision: "acknowledge",
          status: "acknowledged",
          audit_id: "evt_1",
          payment_intent_id: null,
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const decision = await brain.proposals.decide("prop_1", "acknowledge");

    expect(decision.audit_id).toBe("evt_1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/proposals/prop_1/decide");
    expect(await calls[0]!.text()).toBe('{"decision":"acknowledge"}');
  });

  it("throws BrainAPIError on proposal API errors", async () => {
    const { fetch } = mockSequence([
      {
        status: 403,
        body: { error: { code: "payment_intent_approval_invalid", message: "actor_unresolved" } },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.proposals.decide("prop_1", "approve")).rejects.toBeInstanceOf(BrainAPIError);
  });
});

describe("Brain.invoices", () => {
  it("gets an invoice by id", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          id: "inv_1",
          owner_id: "ten_1",
          invoice_number: "INV-1",
          counterparty_id: "cp_1",
          amount_due: "10",
          amount_paid: "0",
          currency: "USD",
          issue_date: "2026-01-01T00:00:00.000Z",
          due_date: null,
          status: "sent",
          linked_document_ids: [],
          linked_transaction_ids: [],
          source_ids: [],
          evidence_ids: [],
          provenance: "human_confirmed",
          confidence: 1,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          metadata: {},
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const invoice = await brain.invoices.get("inv_1");

    expect(invoice.id).toBe("inv_1");
    expect(calls[0]?.url).toContain("/ledger/invoices/inv_1");
  });
});
