import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";

function mockFetch(
  status: number,
  body: unknown,
): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("Brain.auth", () => {
  it("signup posts email and password to /signup, no Authorization header", async () => {
    const { fetch, calls } = mockFetch(201, {
      tenant_id: "tnt_1",
      user_id: "user_1",
      status: "pending",
      verification_token: "tok_1",
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.auth.signup({ email: "a@b.com", password: "at-least-12-chars" });

    expect(result.tenant_id).toBe("tnt_1");
    expect(calls[0]?.url).toContain("/signup");
    expect((calls[0]?.init?.headers as Record<string, string>)?.["Authorization"]).toBeUndefined();
    const sent = JSON.parse(calls[0]?.init?.body as string);
    expect(sent).toEqual({ email: "a@b.com", password: "at-least-12-chars" });
  });

  it("verifyEmail posts tenant_id and token to /auth/verify-email", async () => {
    const { fetch, calls } = mockFetch(200, {
      verified: true,
      user_id: "user_1",
      status: "active",
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.auth.verifyEmail({ tenant_id: "tnt_1", token: "tok_1" });

    expect(result.verified).toBe(true);
    expect(calls[0]?.url).toContain("/auth/verify-email");
  });

  it("login posts email and password to /auth/login", async () => {
    const { fetch, calls } = mockFetch(200, {
      access_token: "jwt.jwt.jwt",
      token_type: "Bearer",
      expires_in: 900,
      principal: { id: "user_1", type: "user", tenantId: "tnt_1", scopes: [] },
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.auth.login({ email: "a@b.com", password: "pw" });

    expect(result.access_token).toBe("jwt.jwt.jwt");
    expect(calls[0]?.url).toContain("/auth/login");
  });

  it("login surfaces a BrainAPIError on 401 (unknown email / wrong password)", async () => {
    const { fetch } = mockFetch(401, {
      error: {
        code: "unauthorized",
        message: "invalid credentials",
        request_id: "trace-1",
        docs_url: "https://docs.brain.fi/resources/errors#unauthorized",
      },
    });
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.auth.login({ email: "a@b.com", password: "wrong" })).rejects.toMatchObject({
      name: "BrainAPIError",
      status: 401,
      code: "unauthorized",
    });
  });

  it("siwxChallenge posts to /auth/siwx/challenge with an empty body", async () => {
    const { fetch, calls } = mockFetch(200, {
      nonce: "n-1",
      session_id: "sess_1",
      domain: "api.brain.fi",
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.auth.siwxChallenge();

    expect(result.session_id).toBe("sess_1");
    expect(calls[0]?.url).toContain("/auth/siwx/challenge");
  });

  it("siwx posts message, signature, and session_id to /auth/siwx", async () => {
    const { fetch, calls } = mockFetch(200, {
      access_token: "jwt.jwt.jwt",
      token_type: "Bearer",
      expires_in: 3600,
      principal: { id: "agent_1", type: "agent", tenantId: "tnt_1", scopes: [] },
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.auth.siwx({
      message: "example.com wants you to sign in...",
      signature: "0xdeadbeef",
      session_id: "sess_1",
    });

    expect(result.principal?.type).toBe("agent");
    const sent = JSON.parse(calls[0]?.init?.body as string);
    expect(sent.session_id).toBe("sess_1");
  });
});

describe("Brain.reference", () => {
  it("yieldVenues fetches the public catalog with no auth header", async () => {
    const { fetch, calls } = mockFetch(200, {
      venues: [{ id: "aave-base", name: "Aave (Base)", apy: 4.2, cap_pct: 40, chain: "base" }],
      chain: "base-sepolia",
    });
    const brain = new Brain({ token: "placeholder", fetch });

    const result = await brain.reference.yieldVenues();

    expect(result.venues).toHaveLength(1);
    expect(calls[0]?.url).toContain("/reference/yield-venues");
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it("propagates a non-200 as BrainAPIError", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    const brain = new Brain({
      token: "placeholder",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(brain.reference.yieldVenues()).rejects.toBeInstanceOf(
      (await import("./errors.js")).BrainAPIError,
    );
  });
});
