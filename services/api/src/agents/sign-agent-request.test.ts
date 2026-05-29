/**
 * Unit tests for the X-Brain-Auth HMAC signer + cross-language round-trip
 * against the Python verifier's canonical bytes.
 *
 * The verifier (services/agents/brain_agents/auth.py) does
 *   hmac_sha256(secret, body).hexdigest()
 *   prefixed with "sha256=".
 *
 * These tests pin that exact contract so a future format drift (different
 * digest, different prefix, different encoding) fails CI on this side and
 * the Python side at the same time.
 */

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { ReconciliationAgentClient } from "./reconciliationClient.js";
import { signAgentRequest } from "./sign-agent-request.js";
import type { ServiceCallContext } from "@brain/shared";

const SECRET = "test-shared-secret";

describe("signAgentRequest", () => {
  it("returns sha256=<hex hmac> for a given body", () => {
    const body = '{"k":"v"}';
    const sig = signAgentRequest(SECRET, body);
    expect(sig.startsWith("sha256=")).toBe(true);
    const expected = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(sig).toBe(`sha256=${expected}`);
  });

  it("is deterministic for the same body", () => {
    const a = signAgentRequest(SECRET, "abc");
    const b = signAgentRequest(SECRET, "abc");
    expect(a).toBe(b);
  });

  it("produces a different signature for a different body", () => {
    const a = signAgentRequest(SECRET, '{"a":1}');
    const b = signAgentRequest(SECRET, '{"a":2}');
    expect(a).not.toBe(b);
  });

  it("produces a different signature for a different secret", () => {
    const a = signAgentRequest("one", "body");
    const b = signAgentRequest("two", "body");
    expect(a).not.toBe(b);
  });
});

describe("ReconciliationAgentClient.propose — outbound HMAC", () => {
  function ctx(): ServiceCallContext {
    return { tenantId: "tnt_01TESTAAAAAAAAAAAAAAAAAA", actor: "usr_01TESTUSER0000000000000000" };
  }

  /** Spy on global fetch so we can assert the headers + body the client sends. */
  function captureFetch(): {
    restore: () => void;
    calls: Array<{ url: string; init: Parameters<typeof fetch>[1] & object }>;
  } {
    const calls: Array<{ url: string; init: Parameters<typeof fetch>[1] & object }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: Parameters<typeof fetch>[1] & object) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          id: "prop_01TEST",
          proposing_agent_id: "agent_01TEST",
          action: {},
          policy_decision_id: "dec_01TEST",
          status: "pending",
          approvers_signed: [],
          created_at: "2026-01-01T00:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    return {
      restore: () => {
        globalThis.fetch = realFetch;
      },
      calls,
    };
  }

  it("sends an X-Brain-Auth header that signs the exact body bytes", async () => {
    const spy = captureFetch();
    try {
      const client = new ReconciliationAgentClient("http://agents.test", {
        signingSecret: SECRET,
      });
      await client.propose(ctx(), "agent_01TEST", { action: { kind: "reconciliation" } });
      const call = spy.calls[0];
      expect(call?.url).toBe("http://agents.test/run/reconciliation");
      const sentBody = call?.init.body as string;
      const sentHeader = (call?.init.headers as Record<string, string>)["X-Brain-Auth"];
      expect(sentHeader).toBe(signAgentRequest(SECRET, sentBody));
    } finally {
      spy.restore();
    }
  });

  it("omits the header when no signing secret is configured (dev path)", async () => {
    const spy = captureFetch();
    try {
      const client = new ReconciliationAgentClient("http://agents.test");
      await client.propose(ctx(), "agent_01TEST", { action: {} });
      const headers = (spy.calls[0]?.init.headers as Record<string, string>) ?? {};
      expect("X-Brain-Auth" in headers).toBe(false);
    } finally {
      spy.restore();
    }
  });

  it("uses the same body bytes for the signature and the request payload", async () => {
    // If main.ts ever switched to passing an object to fetch's body and let
    // it re-serialize, the signature would cover one byte sequence and the
    // verifier would see another. Pin the invariant.
    const spy = captureFetch();
    try {
      const client = new ReconciliationAgentClient("http://agents.test", {
        signingSecret: SECRET,
      });
      await client.propose(ctx(), "agent_01TEST", { action: { kind: "reconciliation" } });
      const call = spy.calls[0];
      expect(typeof call?.init.body).toBe("string");
      const sentBody = call?.init.body as string;
      const sentHeader = (call?.init.headers as Record<string, string>)["X-Brain-Auth"];
      // Re-compute against the EXACT body the verifier will see.
      const expected = `sha256=${createHmac("sha256", SECRET).update(sentBody).digest("hex")}`;
      expect(sentHeader).toBe(expected);
    } finally {
      spy.restore();
    }
  });

  it("propagates a 401 from the verifier as internal_server_error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"detail":{"code":"agents_auth_invalid"}}', { status: 401 })) as typeof fetch;
    try {
      const client = new ReconciliationAgentClient("http://agents.test", {
        signingSecret: SECRET,
      });
      await expect(
        client.propose(ctx(), "agent_01TEST", { action: {} }),
      ).rejects.toMatchObject({ code: "internal_server_error" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
