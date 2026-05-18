import { describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "../index.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeBrain(responses: Array<{ status?: number; body: unknown }>): {
  brain: Brain;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
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
    const r = responses[i++] ?? { body: {} };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { brain: new Brain({ apiKey: "brain_sk_test_initial", fetch }), calls };
}

describe("brain.auth.requestChallenge", () => {
  it("POSTs to /auth/siwx/challenge with no body when agentAddress omitted", async () => {
    const { brain, calls } = makeBrain([
      {
        body: { nonce: "n_abc", session_id: "token_x", domain: "api.brain.fi" },
      },
    ]);
    const challenge = await brain.auth.requestChallenge();
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/auth/siwx/challenge");
    expect(challenge.nonce).toBe("n_abc");
    expect(challenge.session_id).toBe("token_x");
    expect(challenge.domain).toBe("api.brain.fi");
  });

  it("forwards agentAddress as agent_address on the wire", async () => {
    const { brain, calls } = makeBrain([
      {
        body: { nonce: "n", session_id: "s", domain: "d" },
      },
    ]);
    await brain.auth.requestChallenge({ agentAddress: "0xabc" });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.agent_address).toBe("0xabc");
  });
});

describe("brain.auth.signInWithSIWX", () => {
  it("POSTs message + signature + session_id to /auth/siwx", async () => {
    const { brain, calls } = makeBrain([
      {
        body: {
          access_token: "agent_jwt.eyJ.sig",
          token_type: "Bearer",
          expires_in: 3600,
          principal: {
            id: "agent_1",
            type: "agent",
            tenantId: "tnt_1",
            scopes: ["ledger:read"],
          },
        },
      },
    ]);
    const result = await brain.auth.signInWithSIWX({
      message: "siwe message",
      signature: "0xsig",
      sessionId: "token_x",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/auth/siwx");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.message).toBe("siwe message");
    expect(body.signature).toBe("0xsig");
    expect(body.session_id).toBe("token_x");
    expect(result.access_token).toBe("agent_jwt.eyJ.sig");
    expect(result.principal.tenantId).toBe("tnt_1");
  });

  it("rotates the bearer token by default after a successful sign-in", async () => {
    const { brain, calls } = makeBrain([
      // signInWithSIWX response
      {
        body: {
          access_token: "rotated_agent_token",
          token_type: "Bearer",
          expires_in: 3600,
          principal: {
            id: "agent_1",
            type: "agent",
            tenantId: "tnt_1",
            scopes: [],
          },
        },
      },
      // any subsequent call after sign-in
      { body: { accounts: [], next_cursor: null } },
    ]);
    await brain.auth.signInWithSIWX({
      message: "siwe message",
      signature: "0xsig",
      sessionId: "token_x",
    });
    await brain.accounts.list("acme");

    // First call was sign-in: bearer = initial api key.
    expect(calls[0]?.headers.authorization).toBe("Bearer brain_sk_test_initial");
    // Second call: bearer = rotated token from sign-in response.
    expect(calls[1]?.headers.authorization).toBe("Bearer rotated_agent_token");
  });

  it("does NOT rotate when rotateBearer is false", async () => {
    const { brain, calls } = makeBrain([
      {
        body: {
          access_token: "rotated_agent_token",
          token_type: "Bearer",
          expires_in: 3600,
          principal: {
            id: "agent_1",
            type: "agent",
            tenantId: "tnt_1",
            scopes: [],
          },
        },
      },
      { body: { accounts: [], next_cursor: null } },
    ]);
    await brain.auth.signInWithSIWX({
      message: "m",
      signature: "0xsig",
      sessionId: "s",
      rotateBearer: false,
    });
    await brain.accounts.list("acme");
    expect(calls[1]?.headers.authorization).toBe("Bearer brain_sk_test_initial");
  });

  it("omits session_id from the wire when not provided", async () => {
    const { brain, calls } = makeBrain([
      {
        body: {
          access_token: "t",
          token_type: "Bearer",
          expires_in: 3600,
          principal: {
            id: "agent_1",
            type: "agent",
            tenantId: "tnt_1",
            scopes: [],
          },
        },
      },
    ]);
    await brain.auth.signInWithSIWX({
      message: "m",
      signature: "0xsig",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.session_id).toBeUndefined();
  });
});

describe("brain.auth.signOut", () => {
  it("clears the bearer token so subsequent calls send an empty Authorization", async () => {
    const { brain, calls } = makeBrain([{ body: { accounts: [], next_cursor: null } }]);
    brain.auth.signOut();
    await brain.accounts.list("acme");
    expect(calls[0]?.headers.authorization).toBe("Bearer ");
  });
});

describe("BrainHttp.setBearerToken", () => {
  it("rotation is observable on the next request", async () => {
    const { brain, calls } = makeBrain([{ body: { ok: true } }, { body: { ok: true } }]);
    await brain.accounts.list("acme");
    expect(calls[0]?.headers.authorization).toBe("Bearer brain_sk_test_initial");
    brain.http.setBearerToken("manually_rotated");
    await brain.accounts.list("acme");
    expect(calls[1]?.headers.authorization).toBe("Bearer manually_rotated");
  });

  it("hasBearerToken reflects current state", async () => {
    const { brain } = makeBrain([{ body: {} }]);
    expect(brain.http.hasBearerToken()).toBe(true);
    brain.http.setBearerToken(null);
    expect(brain.http.hasBearerToken()).toBe(false);
    brain.http.setBearerToken("x");
    expect(brain.http.hasBearerToken()).toBe(true);
  });
});
