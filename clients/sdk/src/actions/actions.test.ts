import { beforeEach, describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "../index.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeBrain(response: unknown, status = 200): { brain: Brain; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      } else if (!Array.isArray(init.headers)) {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers,
      ...(init?.body !== undefined ? { body: String(init.body) } : {}),
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { brain: new Brain({ apiKey: "brain_sk_test_x", fetch }), calls };
}

describe("brain.actions.create", () => {
  it("POSTs the docs body shape to /actions", async () => {
    const { brain, calls } = makeBrain({
      id: "pi_1",
      tenantId: "acme",
      type: "pay_invoice",
      decision: "ALLOW",
      status: "auto",
    });
    await brain.actions.create({
      tenantId: "acme",
      type: "pay_invoice",
      invoiceId: "inv_8231",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/actions");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.tenantId).toBe("acme");
    expect(body.type).toBe("pay_invoice");
    expect(body.invoiceId).toBe("inv_8231");
  });

  it("translates camelCase SDK opts to snake_case wire fields", async () => {
    const { brain, calls } = makeBrain({ id: "pi_2" });
    await brain.actions.create({
      tenantId: "acme",
      type: "outbound_payment",
      sourceAccountId: "acct_1",
      to: { counterpartyId: "cp_1" },
      amount: "100.00",
      currency: "USD",
      memo: "rent",
      evidenceIds: ["raw_1"],
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.source_account_id).toBe("acct_1");
    expect(body.to).toEqual({ counterparty_id: "cp_1" });
    expect(body.amount).toBe("100.00");
    expect(body.currency).toBe("USD");
    expect(body.memo).toBe("rent");
    expect(body.evidence_ids).toEqual(["raw_1"]);
  });

  it("injects an Idempotency-Key header on create by default", async () => {
    const { brain, calls } = makeBrain({ id: "pi_3" });
    await brain.actions.create({ tenantId: "acme", type: "pay_invoice" });
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^idem_[0-9a-f]{32}$/);
  });

  it("honors a caller-supplied idempotencyKey", async () => {
    const { brain, calls } = makeBrain({ id: "pi_4" });
    await brain.actions.create({
      tenantId: "acme",
      type: "pay_invoice",
      idempotencyKey: "my_key_42",
    });
    expect(calls[0]?.headers["idempotency-key"]).toBe("my_key_42");
  });
});

describe("brain.actions list / get / cancel", () => {
  let brain: Brain;
  let calls: Call[];

  beforeEach(() => {
    ({ brain, calls } = makeBrain({ data: [], next_cursor: null }));
  });

  it("list() hits GET /actions with filters", async () => {
    await brain.actions.list({
      tenantId: "acme",
      status: "needs_approval",
      agentId: "ag_1",
      from: "2026-01-01",
      to: "2026-02-01",
      limit: 25,
    });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/actions");
    expect(calls[0]?.url).toContain("tenantId=acme");
    expect(calls[0]?.url).toContain("status=needs_approval");
    expect(calls[0]?.url).toContain("agent_id=ag_1");
    expect(calls[0]?.url).toContain("from=2026-01-01");
    expect(calls[0]?.url).toContain("to=2026-02-01");
    expect(calls[0]?.url).toContain("limit=25");
  });

  it("get() URL-encodes the action id", async () => {
    ({ brain, calls } = makeBrain({ id: "pi_special/1" }));
    await brain.actions.get("pi_special/1");
    expect(calls[0]?.url).toContain("/actions/pi_special%2F1");
  });

  it("cancel() issues DELETE with an idempotency key", async () => {
    ({ brain, calls } = makeBrain({ id: "pi_5", status: "cancelled" }));
    await brain.actions.cancel("pi_5");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/actions/pi_5");
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^idem_/);
  });
});

describe("brain.actions.approve / reject", () => {
  it("approve() POSTs to /actions/{id}/approve with the `as` + signature body", async () => {
    const { brain, calls } = makeBrain({ id: "pi_6", status: "approved" });
    await brain.actions.approve("pi_6", { as: "user_cfo", signature: "0xsig" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/actions/pi_6/approve");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.as).toBe("user_cfo");
    expect(body.signature).toBe("0xsig");
  });

  it("reject() POSTs to /actions/{id}/reject", async () => {
    const { brain, calls } = makeBrain({ id: "pi_7", status: "rejected" });
    await brain.actions.reject("pi_7", { as: "user_cfo", reason: "Vendor under review" });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(calls[0]?.url).toContain("/actions/pi_7/reject");
    expect(body.reason).toBe("Vendor under review");
  });
});

describe("brain.actions.execute", () => {
  it("POSTs to /actions/{id}/execute and returns the execute result", async () => {
    const { brain, calls } = makeBrain({
      action_id: "pi_8",
      execution_id: "exec_1",
      rail: "bank_api",
      status: "dispatched",
    });
    const result = await brain.actions.execute("pi_8");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/actions/pi_8/execute");
    expect(result.execution_id).toBe("exec_1");
    expect(result.rail).toBe("bank_api");
    expect(result.status).toBe("dispatched");
  });
});
