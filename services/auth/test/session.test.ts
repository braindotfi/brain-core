import { describe, expect, it } from "vitest";
import {
  mintSessionCookie,
  verifySessionCookie,
  mintCsrfCarrier,
  verifyCsrfCarrier,
  deriveCsrfToken,
  verifyCsrfToken,
  serializeHostCookie,
  clearHostCookie,
  parseCookies,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from "../src/session.js";

const SECRET = "test-cookie-secret-do-not-use-in-prod";

describe("AS session cookie", () => {
  it("round-trips tenant_id, user_id, and amr, and carries no member_id claim (finding 8)", () => {
    const minted = mintSessionCookie(SECRET, {
      tenantId: "tnt_abc",
      userId: "user_abc",
      amr: ["pwd"],
    });
    const result = verifySessionCookie(SECRET, minted.cookieValue);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.payload).toMatchObject({
      tenant_id: "tnt_abc",
      user_id: "user_abc",
      amr: ["pwd"],
    });
    expect(result.payload).not.toHaveProperty("member_id");
    expect(result.payload.iat).toBeTypeOf("number");
    expect(result.payload.exp).toBe(result.payload.iat + SESSION_TTL_SECONDS);
  });

  it("rejects a tampered cookie", () => {
    const minted = mintSessionCookie(SECRET, {
      tenantId: "tnt_abc",
      userId: "user_abc",
      amr: ["pwd"],
    });
    const tampered = minted.cookieValue.slice(0, -2) + "xx";
    const result = verifySessionCookie(SECRET, tampered);
    expect(result.ok).toBe(false);
  });

  it("expires exactly at the 15-minute boundary", () => {
    const nowMs = Date.now();
    const minted = mintSessionCookie(
      SECRET,
      { tenantId: "tnt_abc", userId: "user_abc", amr: ["pwd"] },
      nowMs,
    );
    const stillValid = verifySessionCookie(
      SECRET,
      minted.cookieValue,
      nowMs + SESSION_TTL_SECONDS * 1000 - 1000,
    );
    expect(stillValid.ok).toBe(true);
    const expired = verifySessionCookie(
      SECRET,
      minted.cookieValue,
      nowMs + SESSION_TTL_SECONDS * 1000 + 1000,
    );
    expect(expired.ok).toBe(false);
  });

  it("rejects a session cookie value presented to a different secret", () => {
    const minted = mintSessionCookie(SECRET, {
      tenantId: "tnt_abc",
      userId: "user_abc",
      amr: ["pwd"],
    });
    expect(verifySessionCookie("a-different-secret", minted.cookieValue).ok).toBe(false);
  });
});

describe("CSRF derivation", () => {
  it("derives the same token twice for the same carrier cookie", () => {
    const carrier = mintCsrfCarrier(SECRET);
    expect(deriveCsrfToken(SECRET, carrier.cookieValue)).toBe(
      deriveCsrfToken(SECRET, carrier.cookieValue),
    );
  });

  it("verifyCsrfToken accepts the matching token and rejects a mismatch", () => {
    const carrier = mintCsrfCarrier(SECRET);
    const token = deriveCsrfToken(SECRET, carrier.cookieValue);
    expect(verifyCsrfToken(SECRET, carrier.cookieValue, token)).toBe(true);
    expect(verifyCsrfToken(SECRET, carrier.cookieValue, "not-the-token")).toBe(false);
  });

  it("derives a different token for a different carrier (different signature segment)", () => {
    const a = mintCsrfCarrier(SECRET);
    const b = mintCsrfCarrier(SECRET);
    expect(deriveCsrfToken(SECRET, a.cookieValue)).not.toBe(deriveCsrfToken(SECRET, b.cookieValue));
  });

  it("a token derived for one carrier does not verify against another", () => {
    const a = mintCsrfCarrier(SECRET);
    const b = mintCsrfCarrier(SECRET);
    const tokenForA = deriveCsrfToken(SECRET, a.cookieValue);
    expect(verifyCsrfToken(SECRET, b.cookieValue, tokenForA)).toBe(false);
  });

  it("mintCsrfCarrier / verifyCsrfCarrier round-trip and reject a tampered carrier", () => {
    const carrier = mintCsrfCarrier(SECRET);
    expect(verifyCsrfCarrier(SECRET, carrier.cookieValue).ok).toBe(true);
    expect(verifyCsrfCarrier(SECRET, carrier.cookieValue + "x").ok).toBe(false);
  });
});

describe("cookie serialization", () => {
  it("serializeHostCookie sets the __Host- required attributes", () => {
    const cookie = serializeHostCookie(SESSION_COOKIE_NAME, "value123", { maxAgeSeconds: 900 });
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=value123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=900");
    expect(cookie).not.toContain("Domain=");
  });

  it("clearHostCookie zeroes Max-Age", () => {
    expect(clearHostCookie(SESSION_COOKIE_NAME)).toContain("Max-Age=0");
  });

  it("parseCookies parses a multi-cookie header and tolerates garbage", () => {
    expect(parseCookies("a=1; b=2;  c=3")).toEqual({ a: "1", b: "2", c: "3" });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("garbage;;;=")).toEqual({});
  });
});
