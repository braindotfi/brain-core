import { describe, expect, it } from "vitest";
import {
  mintPendingAuthorization,
  pendingAuthorizationToQueryString,
  verifyPendingAuthorization,
  type PendingAuthorizationParams,
} from "../src/pending-authorization.js";
import { verifySessionCookie } from "../src/session.js";

const SECRET = "test-cookie-secret-do-not-use-in-prod";

const PARAMS: PendingAuthorizationParams = {
  response_type: "code",
  client_id: "oacl_abc",
  redirect_uri: "https://example.test/cb",
  scope: "ledger:read wiki:read",
  state: "xyz",
  code_challenge: "challenge-value",
  code_challenge_method: "S256",
  resource: "https://mcp.brain.fi",
};

describe("pending-authorization blob", () => {
  it("round-trips every field", () => {
    const token = mintPendingAuthorization(SECRET, PARAMS);
    const result = verifyPendingAuthorization(SECRET, token);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.payload).toMatchObject(PARAMS);
  });

  it("rejects a tampered token", () => {
    const token = mintPendingAuthorization(SECRET, PARAMS);
    const tampered = token.slice(0, -2) + "xx";
    expect(verifyPendingAuthorization(SECRET, tampered).ok).toBe(false);
  });

  it("expires after the 10-minute TTL", () => {
    const nowMs = Date.now();
    const token = mintPendingAuthorization(SECRET, PARAMS, nowMs);
    expect(verifyPendingAuthorization(SECRET, token, nowMs + 9 * 60 * 1000).ok).toBe(true);
    expect(verifyPendingAuthorization(SECRET, token, nowMs + 11 * 60 * 1000).ok).toBe(false);
  });

  it("rejects a token presented to a different secret", () => {
    const token = mintPendingAuthorization(SECRET, PARAMS);
    expect(verifyPendingAuthorization("a-different-secret", token).ok).toBe(false);
  });

  it("is not accepted by a session-cookie verifier sharing the same secret (domain separation)", () => {
    // session.ts's verifySessionCookie checks aud: "auth.session"; this
    // blob's aud is "authorize_request" (pending-authorization.ts), so it
    // must not verify as a session even under the same AUTH_COOKIE_SECRET.
    const token = mintPendingAuthorization(SECRET, PARAMS);
    expect(verifySessionCookie(SECRET, token).ok).toBe(false);
  });

  it("pendingAuthorizationToQueryString reconstructs an /authorize?... query string", () => {
    const qs = pendingAuthorizationToQueryString(PARAMS);
    const parsed = new URLSearchParams(qs);
    expect(parsed.get("client_id")).toBe(PARAMS.client_id);
    expect(parsed.get("redirect_uri")).toBe(PARAMS.redirect_uri);
    expect(parsed.get("code_challenge")).toBe(PARAMS.code_challenge);
    expect(parsed.get("resource")).toBe(PARAMS.resource);
  });
});
