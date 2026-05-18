import { describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "../index.js";

interface Call {
  url: string;
  method: string;
}

function makeBrain(response: unknown): { brain: Brain; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { brain: new Brain({ apiKey: "brain_sk_test_x", fetch }), calls };
}

describe("brain.cashFlow.summarize", () => {
  it("hits GET /ledger/cash_flows with tenantId + days", async () => {
    const { brain, calls } = makeBrain({
      tenantId: "acme",
      since: "2026-04-15",
      until: "2026-05-15",
      currencies: [],
    });
    await brain.cashFlow.summarize({ tenantId: "acme", days: 30 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/ledger/cash_flows");
    expect(calls[0]?.url).toContain("tenantId=acme");
    expect(calls[0]?.url).toContain("days=30");
  });

  it("forwards currency filter when set", async () => {
    const { brain, calls } = makeBrain({ currencies: [] });
    await brain.cashFlow.summarize({
      tenantId: "acme",
      days: 7,
      currency: "EUR",
    });
    expect(calls[0]?.url).toContain("currency=EUR");
  });

  it("returns the parsed body verbatim", async () => {
    const body = {
      tenantId: "acme",
      since: "2026-04-15T00:00:00Z",
      until: "2026-05-15T00:00:00Z",
      currencies: [
        {
          currency: "USD",
          inflow: "1000.00",
          outflow: "300.00",
          net: "700.00",
          transaction_count: 5,
          by_day: [],
        },
      ],
    };
    const { brain } = makeBrain(body);
    const summary = await brain.cashFlow.summarize({ tenantId: "acme" });
    expect(summary).toEqual(body);
  });
});
