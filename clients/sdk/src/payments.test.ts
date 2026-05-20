import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";
import { BrainAPIError, PolicyApprovalRequiredError, PolicyRejectedError } from "./errors.js";

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

const BASE_INTENT_PARAMS = {
  action_type: "ach_outbound" as const,
  source_account_id: "acct_1",
  destination_counterparty_id: "cp_1",
  amount: "100.00",
  currency: "USD",
};

describe("Brain.payments", () => {
  it("create posts the body and forwards Idempotency-Key", async () => {
    const { fetch, calls } = mockSequence([
      { status: 201, body: { id: "pi_1", status: "approved" } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const intent = await brain.payments.create({
      ...BASE_INTENT_PARAMS,
      idempotencyKey: "key-123",
    });

    expect(intent.id).toBe("pi_1");
    const request = calls[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/payment-intents");
    expect(request.headers.get("idempotency-key")).toBe("key-123");
    const sentBody = await request.text();
    expect(sentBody).not.toContain("idempotencyKey");
    expect(sentBody).toContain('"action_type":"ach_outbound"');
  });

  it("create omits the Idempotency-Key header when not provided", async () => {
    const { fetch, calls } = mockSequence([
      { status: 201, body: { id: "pi_1", status: "approved" } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await brain.payments.create(BASE_INTENT_PARAMS);

    expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
  });

  it("get fetches by id", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { id: "pi_1", status: "executed" } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const intent = await brain.payments.get("pi_1");

    expect(intent.id).toBe("pi_1");
    expect(calls[0]?.url).toContain("/payment-intents/pi_1");
  });

  it("approve posts to the approve endpoint", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { id: "pi_1", status: "approved" } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const intent = await brain.payments.approve("pi_1");

    expect(intent.status).toBe("approved");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/payment-intents/pi_1/approve");
  });

  it("reject posts a reason when supplied", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { id: "pi_1", status: "rejected" } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await brain.payments.reject("pi_1", { reason: "duplicate" });

    const bodyText = await calls[0]!.text();
    expect(bodyText).toContain("duplicate");
  });

  it("reject sends no body when reason omitted", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { id: "pi_1", status: "rejected" } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await brain.payments.reject("pi_1");

    const bodyText = await calls[0]!.text();
    expect(bodyText).toBe("");
  });

  it("execute returns the receipt", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 202,
        body: {
          payment_intent_id: "pi_1",
          execution_id: "ex_1",
          rail: "bank_ach",
          status: "dispatched",
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const receipt = await brain.payments.execute("pi_1");

    expect(receipt).toEqual({
      paymentIntentId: "pi_1",
      executionId: "ex_1",
      rail: "bank_ach",
      status: "dispatched",
    });
    expect(calls[0]?.url).toContain("/payment-intents/pi_1/execute");
  });
});

describe("Brain.pay (compound)", () => {
  it("auto-executes when status=approved", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 201,
        body: { id: "pi_1", status: "approved" },
      },
      {
        status: 202,
        body: { execution_id: "ex_1", status: "dispatched" },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.pay("acme", BASE_INTENT_PARAMS);

    expect(result.intent.status).toBe("approved");
    expect(result.execution?.executionId).toBe("ex_1");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/payment-intents");
    expect(calls[1]?.url).toContain("/payment-intents/pi_1/execute");
  });

  it("throws PolicyApprovalRequiredError when status=pending_approval", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 201,
        body: {
          id: "pi_1",
          status: "pending_approval",
          policy_decision_id: "pd_1",
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.pay("acme", BASE_INTENT_PARAMS)).rejects.toMatchObject({
      name: "PolicyApprovalRequiredError",
      intent: expect.objectContaining({ id: "pi_1" }),
      policyDecisionId: "pd_1",
    });
    expect(calls).toHaveLength(1);
  });

  it("throws PolicyRejectedError when status=rejected", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 201,
        body: {
          id: "pi_1",
          status: "rejected",
          policy_decision_id: "pd_2",
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.pay("acme", BASE_INTENT_PARAMS)).rejects.toBeInstanceOf(PolicyRejectedError);
    expect(calls).toHaveLength(1);
  });

  it("returns intent without executing on other statuses", async () => {
    const { fetch, calls } = mockSequence([
      { status: 201, body: { id: "pi_1", status: "proposed" } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.pay("acme", BASE_INTENT_PARAMS);

    expect(result.intent.status).toBe("proposed");
    expect(result.execution).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("propagates HTTP errors from create", async () => {
    const { fetch } = mockSequence([
      {
        status: 403,
        body: { code: "forbidden", message: "no auth" },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.pay("acme", BASE_INTENT_PARAMS)).rejects.toBeInstanceOf(BrainAPIError);
  });
});

describe("Brain.approve / Brain.reject (flat helpers)", () => {
  it("brain.approve delegates to payments.approve", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { id: "pi_1", status: "approved" } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await brain.approve("pi_1");

    expect(calls[0]?.url).toContain("/payment-intents/pi_1/approve");
  });

  it("brain.reject forwards reason", async () => {
    const { fetch, calls } = mockSequence([
      { status: 200, body: { id: "pi_1", status: "rejected" } },
    ]);
    const brain = new Brain({ token: "k", fetch });

    await brain.reject("pi_1", { reason: "fraud" });

    const bodyText = await calls[0]!.text();
    expect(bodyText).toContain("fraud");
  });
});

describe("PolicyApprovalRequiredError", () => {
  it("captures the intent and policy decision id", () => {
    const err = new PolicyApprovalRequiredError({
      id: "pi_1",
      status: "pending_approval",
      policy_decision_id: "pd_1",
    } as never);
    expect(err.intent.id).toBe("pi_1");
    expect(err.policyDecisionId).toBe("pd_1");
    expect(err.message).toContain("pi_1");
  });
});

describe("PolicyRejectedError", () => {
  it("captures the intent and policy decision id", () => {
    const err = new PolicyRejectedError({
      id: "pi_1",
      status: "rejected",
      policy_decision_id: "pd_2",
    } as never);
    expect(err.intent.id).toBe("pi_1");
    expect(err.policyDecisionId).toBe("pd_2");
    expect(err.message).toContain("pd_2");
  });
});
