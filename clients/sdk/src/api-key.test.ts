import { describe, expect, it, vi } from "vitest";

import {
  AgentTokenExchangeError,
  AgentTokenManager,
  createAgentAuthenticatedFetch,
} from "./agent-api-key.js";
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

const TOKEN_URL = "https://auth.example.test/token";
const RESOURCE = "https://api.example.test/";
const AGENT_KEY = "brain_ak_test_agkey_01TEST_secret"; // gitleaks:allow

function agentJwt(now: number, suffix = "1", audience = RESOURCE): string {
  const claims = {
    iss: "https://auth.brain.fi",
    aud: audience,
    sub: "agent_01TESTAAAAAAAAAAAAAAAA",
    tenant_id: "tnt_01TESTAAAAAAAAAAAAAAAAAA",
    principal_type: "agent",
    credential_id: "agkey_01TESTAAAAAAAAAAAAAA",
    scopes: ["raw:write"],
    iat: now,
    exp: now + 300,
    jti: `token_${suffix}`,
  };
  const payload = btoa(JSON.stringify(claims))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${payload}.signature`;
}

function exchangeResponse(token: string): Response {
  return new Response(
    JSON.stringify({
      access_token: token,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: 300,
      scope: "raw:write",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

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

  it("accepts agentApiKey alone and rejects mixed credential modes", () => {
    expect(() => new Brain({ agentApiKey: AGENT_KEY })).not.toThrow();
    expect(() => new Brain({ token: "t", agentApiKey: AGENT_KEY })).toThrow(/exactly one/);
    expect(() => new Brain({ apiKey: "brain_sk_x", agentApiKey: AGENT_KEY })).toThrow(
      /exactly one/,
    );
  });
});

describe("apiKey mode", () => {
  it("sends the key directly as the bearer credential", async () => {
    const { fetch, calls } = mockRouter({
      "/v1/audit/anchor/latest": () => jsonOk(),
    });
    const http = createBrainHttpClient({ apiKey: "brain_sk_test", fetch });

    await http.ready();
    expect(calls).toHaveLength(0);
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

describe("agentApiKey mode", () => {
  it("exchanges at ready, validates the JWT, and never sends the key to the API", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = agentJwt(now);
    const calls: Request[] = [];
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = new Request(input, init);
        calls.push(request.clone());
        return request.url === TOKEN_URL ? exchangeResponse(token) : jsonOk();
      },
    ) as unknown as typeof globalThis.fetch;
    const brain = new Brain({
      agentApiKey: AGENT_KEY,
      tokenUrl: TOKEN_URL,
      resource: RESOURCE,
      agentScope: "raw:write",
      baseUrl: "https://api.example.test/v1",
      fetch,
    });

    await brain.ready();
    await brain.http.GET("/audit/anchor/latest");
    await brain.http.GET("/audit/anchor/latest");

    expect(calls).toHaveLength(3);
    const form = new URLSearchParams(await calls[0]!.text());
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: AGENT_KEY,
      subject_token_type: "urn:brain:params:oauth:token-type:agent-api-key",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: RESOURCE,
      scope: "raw:write",
    });
    expect(calls[1]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(calls[2]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(calls[1]!.headers.get("authorization")).not.toContain(AGENT_KEY);
  });

  it("refreshes early and coalesces concurrent exchanges", async () => {
    let now = 1_800_000_000;
    let exchanges = 0;
    let release: (() => void) | undefined;
    const secondMayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async () => {
      exchanges += 1;
      if (exchanges === 2) await secondMayFinish;
      return exchangeResponse(agentJwt(now, String(exchanges)));
    }) as unknown as typeof globalThis.fetch;
    const manager = new AgentTokenManager({
      agentApiKey: AGENT_KEY,
      tokenUrl: TOKEN_URL,
      resource: RESOURCE,
      scope: "raw:write",
      fetch,
      now: () => now,
    });

    await manager.ready();
    now += 241;
    const concurrent = Array.from({ length: 8 }, () => manager.getAccessToken());
    await Promise.resolve();
    release!();
    const tokens = await Promise.all(concurrent);

    expect(exchanges).toBe(2);
    expect(new Set(tokens).size).toBe(1);
  });

  it("exchanges and retries exactly once after a 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tokens = [agentJwt(now, "first"), agentJwt(now, "second")];
    const apiCredentials: string[] = [];
    let exchanges = 0;
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = new Request(input, init);
        if (request.url === TOKEN_URL) {
          const token = tokens[exchanges]!;
          exchanges += 1;
          return exchangeResponse(token);
        }
        apiCredentials.push(request.headers.get("authorization") ?? "");
        return new Response("{}", { status: apiCredentials.length === 1 ? 401 : 200 });
      },
    ) as unknown as typeof globalThis.fetch;
    const http = createBrainHttpClient({
      agentApiKey: AGENT_KEY,
      tokenUrl: TOKEN_URL,
      resource: RESOURCE,
      agentScope: "raw:write",
      baseUrl: "https://api.example.test/v1",
      fetch,
    });

    await http.GET("/audit/anchor/latest");

    expect(exchanges).toBe(2);
    expect(apiCredentials).toEqual([`Bearer ${tokens[0]}`, `Bearer ${tokens[1]}`]);
  });

  it("replays a POST body once and stops when the retry is also unauthorized", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tokens = [agentJwt(now, "first"), agentJwt(now, "second")];
    const requestBodies: string[] = [];
    const apiCredentials: string[] = [];
    let exchanges = 0;
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = new Request(input, init);
        if (request.url === TOKEN_URL) {
          const token = tokens[exchanges]!;
          exchanges += 1;
          return exchangeResponse(token);
        }
        requestBodies.push(await request.text());
        apiCredentials.push(request.headers.get("authorization") ?? "");
        return new Response("{}", { status: 401 });
      },
    ) as unknown as typeof globalThis.fetch;
    const authenticated = createAgentAuthenticatedFetch({
      agentApiKey: AGENT_KEY,
      tokenUrl: TOKEN_URL,
      resource: RESOURCE,
      scope: "raw:write",
      fetch,
    });

    const response = await authenticated.fetch("https://api.example.test/v1/raw/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"sourceType":"text"}',
    });

    expect(response.status).toBe(401);
    expect(exchanges).toBe(2);
    expect(requestBodies).toEqual(['{"sourceType":"text"}', '{"sourceType":"text"}']);
    expect(apiCredentials).toEqual([`Bearer ${tokens[0]}`, `Bearer ${tokens[1]}`]);
  });

  it("fails closed on an invalid exchanged audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fetch = vi.fn(async () =>
      exchangeResponse(agentJwt(now, "1", "https://wrong/")),
    ) as unknown as typeof globalThis.fetch;
    const manager = new AgentTokenManager({
      agentApiKey: AGENT_KEY,
      tokenUrl: TOKEN_URL,
      resource: RESOURCE,
      scope: "raw:write",
      fetch,
    });

    await expect(manager.ready()).rejects.toBeInstanceOf(AgentTokenExchangeError);
  });

  it("rejects a token response that includes a refresh token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fetch = vi.fn(async () => {
      const response = await exchangeResponse(agentJwt(now)).json();
      return new Response(JSON.stringify({ ...response, refresh_token: "must-not-be-issued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const manager = new AgentTokenManager({
      agentApiKey: AGENT_KEY,
      tokenUrl: TOKEN_URL,
      resource: RESOURCE,
      scope: "raw:write",
      fetch,
    });

    await expect(manager.ready()).rejects.toBeInstanceOf(AgentTokenExchangeError);
  });
});
