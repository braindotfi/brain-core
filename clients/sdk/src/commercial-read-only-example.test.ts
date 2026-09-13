import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runCommercialReadOnlySmoke } from "../examples/commercial-read-only.js";

describe("commercial read-only example", () => {
  it("keeps the public quickstart inside the commercial key scope ceiling", () => {
    const quickstart = readFileSync(
      new URL("../../../introduction/quickstart.md", import.meta.url),
      "utf8",
    );
    expect(quickstart).toContain("apiKey: process.env.BRAIN_API_KEY");
    expect(quickstart).toContain("brain.accounts.list");
    expect(quickstart).toContain("brain.transactions.list");
    expect(quickstart).toContain("brain.audit.list");
    expect(quickstart).toContain('brain.http.GET("/governance/agents"');
    for (const forbiddenCall of [
      "brain.ask(",
      "brain.pay(",
      "brain.approve(",
      "brain.payments.execute(",
      "brain.proof(",
    ]) {
      expect(quickstart).not.toContain(forbiddenCall);
    }
  });

  it("uses a brain_sk key for ledger, audit, and governance GETs only", async () => {
    const calls: Array<{ method: string; url: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get("authorization"),
      });
      const pathname = new URL(request.url).pathname;
      const body = pathname.endsWith("/ledger/accounts")
        ? { accounts: [], next_cursor: null }
        : pathname.endsWith("/ledger/transactions")
          ? { transactions: [], next_cursor: null }
          : pathname.endsWith("/audit/events")
            ? { events: [], next_cursor: null }
            : { agents: [], next_cursor: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      runCommercialReadOnlySmoke(
        {
          BRAIN_API_KEY: "brain_sk_test_example",
          BRAIN_TENANT_ID: "tnt_01K123456789ABCDEFGHJKMNPQ",
          BRAIN_BASE_URL: "https://example.test/v1",
        },
        fetchImpl,
      ),
    ).resolves.toEqual({ accounts: 0, transactions: 0, auditEvents: 0, governanceAgents: 0 });

    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.map((call) => new URL(call.url).pathname).sort()).toEqual([
      "/v1/audit/events",
      "/v1/governance/agents",
      "/v1/ledger/accounts",
      "/v1/ledger/transactions",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer brain_sk_test_example")).toBe(true);
  });

  it("rejects the wrong credential family before making a request", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runCommercialReadOnlySmoke(
        {
          BRAIN_API_KEY: "brain_ak_live_not-a-commercial-key",
          BRAIN_TENANT_ID: "tnt_01K123456789ABCDEFGHJKMNPQ",
        },
        fetchImpl,
      ),
    ).rejects.toThrow("brain_sk_test_* or brain_sk_live_*");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
