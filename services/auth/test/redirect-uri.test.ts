import { describe, expect, it } from "vitest";
import { isRegistrableRedirectUri, matchesRedirectUri } from "../src/redirect-uri.js";

describe("isRegistrableRedirectUri", () => {
  it("accepts https://", () => {
    expect(isRegistrableRedirectUri("https://example.test/cb")).toBe(true);
  });

  it("accepts a loopback http:// literal (127.0.0.1)", () => {
    expect(isRegistrableRedirectUri("http://127.0.0.1:51000/cb")).toBe(true);
  });

  it("accepts a loopback http:// literal (::1)", () => {
    expect(isRegistrableRedirectUri("http://[::1]:51000/cb")).toBe(true);
  });

  it("rejects plain http:// on a non-loopback host", () => {
    expect(isRegistrableRedirectUri("http://example.test/cb")).toBe(false);
  });

  it("rejects a redirect_uri containing a fragment", () => {
    expect(isRegistrableRedirectUri("https://example.test/cb#frag")).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(isRegistrableRedirectUri("not-a-url")).toBe(false);
  });
});

describe("matchesRedirectUri", () => {
  const registered = ["https://example.test/callback"];

  it("accepts a byte-for-byte exact match", () => {
    expect(matchesRedirectUri(registered, "https://example.test/callback")).toBe(true);
  });

  it("rejects a trailing-slash difference", () => {
    expect(matchesRedirectUri(registered, "https://example.test/callback/")).toBe(false);
  });

  it("rejects a case difference in the path", () => {
    expect(matchesRedirectUri(registered, "https://example.test/Callback")).toBe(false);
  });

  it("rejects an extra query parameter", () => {
    expect(matchesRedirectUri(registered, "https://example.test/callback?extra=1")).toBe(false);
  });

  it("rejects a fragment", () => {
    expect(matchesRedirectUri(registered, "https://example.test/callback#frag")).toBe(false);
  });

  it("rejects a subdomain", () => {
    expect(matchesRedirectUri(registered, "https://evil.example.test/callback")).toBe(false);
  });

  it("rejects a different scheme", () => {
    expect(matchesRedirectUri(registered, "http://example.test/callback")).toBe(false);
  });

  it("accepts loopback port variation (RFC 8252 section 7.3)", () => {
    const loopbackRegistered = ["http://127.0.0.1:0/cb"];
    expect(matchesRedirectUri(loopbackRegistered, "http://127.0.0.1:54321/cb")).toBe(true);
    expect(matchesRedirectUri(loopbackRegistered, "http://127.0.0.1:1/cb")).toBe(true);
  });

  it("loopback port variation still requires an exact path match", () => {
    const loopbackRegistered = ["http://127.0.0.1:0/cb"];
    expect(matchesRedirectUri(loopbackRegistered, "http://127.0.0.1:54321/other")).toBe(false);
  });

  it("loopback port variation never applies to a non-loopback registered entry", () => {
    expect(matchesRedirectUri(registered, "http://127.0.0.1:54321/callback")).toBe(false);
  });

  it("rejects a malformed candidate", () => {
    expect(matchesRedirectUri(registered, "not-a-url")).toBe(false);
  });
});
