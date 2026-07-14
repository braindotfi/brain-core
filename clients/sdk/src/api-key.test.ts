import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";
import { createBrainHttpClient } from "./client.js";

interface Call {
  url: string;
  headers: Headers;
}

/** Routes a fake fetch by pathname; records every call (both `Request`-object
 * calls from openapi-fetch and raw `(url, init)` calls from the exchange). */
function mockRouter(handlers: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: Request | string, init?: RequestInit) => {
    const isRequest = typeof input !== "string";
    const url = isRequest ? input.url : input;
    const headers = isRequest ? input.headers : new Headers(init?.headers);
    const call: Call = { url, headers };
    calls.push(call);
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`mockRouter: unhandled path ${path}`);
    return handler(call);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function exchangeOk(token: string): Response {
  return new Response(
    JSON.stringify({
      token,
      token_type: "Bearer",
      expires_in: 3600,
      tenant_id: "tnt_1",
      agent_id: "agent_1",
      scopes: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const jsonOk = () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

describe("Brain constructor: token/apiKey validation", () => {
  it("throws when neither token nor apiKey is provided", () => {
    expect(() => new Brain({})).toThrow(/exactly one/);
  });

  it("throws when both token and apiKey are provided", () => {
    expect(() => new Brain({ token: "t", apiKey: "brain_sk_x" })).toThrow(/exactly one/);
  });

  it("accepts apiKey alone", () => {
    expect(() => new Brain({ apiKey: "brain_sk_x" })).not.toThrow();
  });
});

describe("apiKey mode: lazy exchange", () => {
  it("exchanges on first request and attaches the returned bearer token", async () => {
    const { fetch, calls } = mockRouter({
      "/v1/auth/api-key": () => exchangeOk("bearer-1"),
      "/v1/audit/anchor/latest": () => jsonOk(),
    });
    const http = createBrainHttpClient({ apiKey: "brain_sk_test", fetch });

    await http.GET("/audit/anchor/latest");

    const exchangeCalls = calls.filter((c) => c.url.includes("/auth/api-key"));
    expect(exchangeCalls).toHaveLength(1);
    expect(exchangeCalls[0]?.headers.get("x-api-key")).toBe("brain_sk_test");

    const mainCall = calls.find((c) => c.url.includes("/audit/anchor/latest"));
    expect(mainCall?.headers.get("authorization")).toBe("Bearer bearer-1");
  });

  it("on a 401, invalidates the cache, re-exchanges once, and retries the original request once", async () => {
    let exchangeCalls = 0;
    let mainCalls = 0;
    const { fetch } = mockRouter({
      "/v1/auth/api-key": () => {
        exchangeCalls += 1;
        return exchangeOk(`bearer-${exchangeCalls}`);
      },
      "/v1/audit/anchor/latest": (call) => {
        mainCalls += 1;
        if (call.headers.get("authorization") === "Bearer bearer-1") {
          return new Response(
            JSON.stringify({ error: { code: "auth_token_invalid", message: "expired" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        return jsonOk();
      },
    });
    const http = createBrainHttpClient({ apiKey: "brain_sk_test", fetch });

    const { response } = await http.GET("/audit/anchor/latest");

    expect(response.status).toBe(200);
    expect(exchangeCalls).toBe(2); // initial + one re-exchange after the 401
    expect(mainCalls).toBe(2); // original + exactly one retry, no loop
  });

  it("does not retry a second time if the retried request also 401s", async () => {
    let exchangeCalls = 0;
    let mainCalls = 0;
    const { fetch } = mockRouter({
      "/v1/auth/api-key": () => {
        exchangeCalls += 1;
        return exchangeOk(`bearer-${exchangeCalls}`);
      },
      "/v1/audit/anchor/latest": () => {
        mainCalls += 1;
        return new Response(
          JSON.stringify({ error: { code: "auth_token_invalid", message: "still invalid" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      },
    });
    const http = createBrainHttpClient({ apiKey: "brain_sk_test", fetch });

    const { response } = await http.GET("/audit/anchor/latest");

    expect(response.status).toBe(401);
    expect(exchangeCalls).toBe(2); // initial + one forced re-exchange, then it gives up
    expect(mainCalls).toBe(2);
  });

  it("serializes concurrent first requests into exactly one exchange", async () => {
    let exchangeCalls = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { fetch } = mockRouter({
      "/v1/auth/api-key": async () => {
        exchangeCalls += 1;
        await gate;
        return exchangeOk("bearer-1");
      },
      "/v1/audit/anchor/latest": () => jsonOk(),
    });
    const http = createBrainHttpClient({ apiKey: "brain_sk_test", fetch });

    const p1 = http.GET("/audit/anchor/latest");
    const p2 = http.GET("/audit/anchor/latest");
    releaseGate?.();
    await Promise.all([p1, p2]);

    expect(exchangeCalls).toBe(1);
  });

  it("throws a clear error when the exchange 404s (feature not enabled)", async () => {
    const { fetch } = mockRouter({
      "/v1/auth/api-key": () => new Response("", { status: 404 }),
    });
    const http = createBrainHttpClient({ apiKey: "brain_sk_test", fetch });

    await expect(http.GET("/audit/anchor/latest")).rejects.toThrow(/not enabled/);
  });
});

describe("token mode", () => {
  it("never calls the api-key exchange endpoint", async () => {
    const { fetch, calls } = mockRouter({
      "/v1/audit/anchor/latest": () => jsonOk(),
    });
    const http = createBrainHttpClient({ token: "jwt-token", fetch });

    await http.GET("/audit/anchor/latest");

    expect(calls.every((c) => !c.url.includes("/auth/api-key"))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-token");
  });
});
