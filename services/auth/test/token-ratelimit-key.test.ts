/**
 * BRAIN-98: the /token rate-limit key must key on client_id + ip, not
 * client_id alone. client_id is caller-controlled and unauthenticated at
 * this preHandler hook (it runs before the handler validates any code or
 * refresh_token), so keying on it alone lets an attacker who merely reads a
 * victim client_id out of a public /authorize URL exhaust that client's
 * bucket from their own IP, 429-ing every legitimate exchange or refresh for
 * that client from any other IP.
 */

import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { tokenRateLimitKey } from "../src/routes/oauth.js";

function fakeRequest(clientId: string | undefined, ip: string): FastifyRequest {
  return {
    body: clientId === undefined ? {} : { client_id: clientId },
    ip,
  } as unknown as FastifyRequest;
}

describe("tokenRateLimitKey", () => {
  it("keys on client_id + ip: one client_id hammered from IP A does not share a bucket with IP B", () => {
    const keyFromIpA = tokenRateLimitKey(fakeRequest("client-victim", "1.2.3.4"));
    const keyFromIpB = tokenRateLimitKey(fakeRequest("client-victim", "5.6.7.8"));
    expect(keyFromIpA).not.toBe(keyFromIpB);
  });

  it("the same client_id and ip always produce the same key", () => {
    const first = tokenRateLimitKey(fakeRequest("client-a", "1.2.3.4"));
    const second = tokenRateLimitKey(fakeRequest("client-a", "1.2.3.4"));
    expect(first).toBe(second);
  });

  it("falls back to anon for a missing client_id, still scoped by ip", () => {
    const key = tokenRateLimitKey(fakeRequest(undefined, "9.9.9.9"));
    expect(key).toBe("anon:9.9.9.9");
  });
});
