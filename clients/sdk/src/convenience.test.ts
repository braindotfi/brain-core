import { describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "./index.js";

interface Call {
  url: string;
  method: string;
  body?: string;
}

/**
 * Multi-response stub. Each call indexes into `responses`, defaulting
 * to an empty 200 once we run past the array.
 */
function makeBrain(
  responses: Array<{ status?: number; body: unknown }>,
): { brain: Brain; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { body: String(init.body) } : {}),
    });
    const r = responses[i++] ?? { body: {} };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { brain: new Brain({ apiKey: "brain_sk_test_x", fetch }), calls };
}

describe("brain.ask", () => {
  it("delegates to brain.wiki.question with positional tenantId", async () => {
    const { brain, calls } = makeBrain([
      { body: { answer: "100 USD", citations: [] } },
    ]);
    const answer = await brain.ask("acme", "How much did we spend?");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/wiki/question");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.tenantId).toBe("acme");
    expect(body.question).toBe("How much did we spend?");
    expect((answer as { answer: string }).answer).toBe("100 USD");
  });
});

describe("brain.pay", () => {
  it("auto-executes on ALLOW: create → execute → re-fetch", async () => {
    const { brain, calls } = makeBrain([
      // POST /actions
      {
        status: 201,
        body: { id: "pi_1", tenantId: "acme", type: "pay_invoice", decision: "ALLOW", status: "auto" },
      },
      // POST /actions/pi_1/execute
      {
        status: 202,
        body: { action_id: "pi_1", execution_id: "exec_1", rail: "bank_api", status: "dispatched" },
      },
      // GET /actions/pi_1 (re-fetch for final state)
      {
        body: { id: "pi_1", tenantId: "acme", decision: "ALLOW", status: "executed" },
      },
    ]);
    const action = await brain.pay("acme", { invoiceId: "inv_8231" });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain("/actions");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[1]?.url).toContain("/actions/pi_1/execute");
    expect(calls[2]?.url).toContain("/actions/pi_1");
    expect(calls[2]?.method).toBe("GET");
    expect((action as { status: string }).status).toBe("executed");
  });

  it("ESCALATE: stops after create, returns needs_approval state", async () => {
    const { brain, calls } = makeBrain([
      {
        status: 201,
        body: {
          id: "pi_2",
          tenantId: "acme",
          decision: "ESCALATE",
          status: "needs_approval",
          approvers: ["role:cfo"],
        },
      },
    ]);
    const action = await brain.pay("acme", { invoiceId: "inv_9000" });
    expect(calls).toHaveLength(1);
    expect((action as { status: string }).status).toBe("needs_approval");
  });

  it("DENY: stops after create, returns rejected state", async () => {
    const { brain, calls } = makeBrain([
      {
        status: 201,
        body: { id: "pi_3", decision: "DENY", status: "rejected" },
      },
    ]);
    const action = await brain.pay("acme", { invoiceId: "inv_X" });
    expect(calls).toHaveLength(1);
    expect((action as { status: string }).status).toBe("rejected");
  });

  it("defaults type to pay_invoice when invoiceId is set", async () => {
    const { brain, calls } = makeBrain([
      { status: 201, body: { id: "pi_x", decision: "DENY", status: "rejected" } },
    ]);
    await brain.pay("acme", { invoiceId: "inv_1" });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.type).toBe("pay_invoice");
  });

  it("defaults type to outbound_payment when invoiceId is absent", async () => {
    const { brain, calls } = makeBrain([
      { status: 201, body: { id: "pi_y", decision: "DENY", status: "rejected" } },
    ]);
    await brain.pay("acme", {
      to: { counterpartyId: "cp_1" },
      amount: "100.00",
      currency: "USD",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.type).toBe("outbound_payment");
  });
});

describe("brain.approve / brain.reject", () => {
  it("approve() forwards to actions.approve", async () => {
    const { brain, calls } = makeBrain([{ body: { id: "pi_1", status: "approved" } }]);
    await brain.approve("pi_1", { as: "user_cfo" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/actions/pi_1/approve");
    expect(JSON.parse(calls[0]?.body ?? "{}").as).toBe("user_cfo");
  });

  it("reject() forwards to actions.reject", async () => {
    const { brain, calls } = makeBrain([{ body: { id: "pi_1", status: "rejected" } }]);
    await brain.reject("pi_1", { reason: "nope" });
    expect(calls[0]?.url).toContain("/actions/pi_1/reject");
    expect(JSON.parse(calls[0]?.body ?? "{}").reason).toBe("nope");
  });
});

describe("brain.trace / brain.proof", () => {
  it("trace() hits /audit/entity/payment_intent/{id}", async () => {
    const { brain, calls } = makeBrain([
      { body: { entity_type: "payment_intent", entity_id: "pi_1", events: [{ id: "evt_1", action: "payment_intent.created" }] } },
    ]);
    const trail = await brain.trace("pi_1");
    expect(calls[0]?.url).toContain("/audit/entity/payment_intent/pi_1");
    expect(trail.events).toHaveLength(1);
  });

  it("proof() picks the latest .executed event then calls /audit/event/{id}/proof", async () => {
    const { brain, calls } = makeBrain([
      // /audit/entity/payment_intent/pi_1
      {
        body: {
          entity_type: "payment_intent",
          entity_id: "pi_1",
          events: [
            { id: "evt_1", action: "payment_intent.created" },
            { id: "evt_2", action: "payment_intent.executed" },
          ],
        },
      },
      // /audit/event/evt_2/proof
      {
        body: {
          event: { id: "evt_2" },
          merkle_path: ["0xa"],
          anchored_root: "0xroot",
          base_tx_hash: "0xtx",
          base_block: 100,
          batch_index: 1,
        },
      },
    ]);
    const proof = await brain.proof("pi_1");
    expect(calls[0]?.url).toContain("/audit/entity/payment_intent/pi_1");
    expect(calls[1]?.url).toContain("/audit/event/evt_2/proof");
    expect(proof.anchored_root).toBe("0xroot");
  });

  it("proof() falls back to the latest event when no .executed exists", async () => {
    const { brain, calls } = makeBrain([
      {
        body: {
          entity_type: "payment_intent",
          entity_id: "pi_X",
          events: [
            { id: "evt_a", action: "payment_intent.created" },
            { id: "evt_b", action: "policy.evaluated" },
          ],
        },
      },
      {
        body: {
          event: { id: "evt_b" },
          merkle_path: [],
          anchored_root: "0xroot",
          base_tx_hash: "0x",
          base_block: 0,
          batch_index: 0,
        },
      },
    ]);
    await brain.proof("pi_X");
    expect(calls[1]?.url).toContain("/audit/event/evt_b/proof");
  });

  it("proof() throws when no audit events exist", async () => {
    const { brain } = makeBrain([
      { body: { entity_type: "payment_intent", entity_id: "pi_Y", events: [] } },
    ]);
    await expect(brain.proof("pi_Y")).rejects.toThrow(/no audit events/);
  });
});
