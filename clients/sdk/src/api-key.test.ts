import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";
import { createBrainHttpClient } from "./client.js";

interface Call {
  url: string;
  headers: Headers;
}

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

describe("apiKey mode", () => {
  it("sends the key directly as the bearer credential", async () => {
    const { fetch, calls } = mockRouter({
      "/v1/audit/anchor/latest": () => jsonOk(),
    });
    const http = createBrainHttpClient({ apiKey: "brain_sk_test", fetch });

    await http.GET("/audit/anchor/latest");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer brain_sk_test");
  });
});

describe("token mode", () => {
  it("sends the JWT bearer token", async () => {
    const { fetch, calls } = mockRouter({
      "/v1/audit/anchor/latest": () => jsonOk(),
    });
    const http = createBrainHttpClient({ token: "jwt-token", fetch });

    await http.GET("/audit/anchor/latest");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-token");
  });
});
