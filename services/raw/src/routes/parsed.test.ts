import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import {
  computeServiceAuthSignatureV2,
  parseRawParsedWriteBody,
  verifyServiceAuthSignatureV2,
} from "./parsed.js";

// Pure-function coverage for the POST /raw/{id}/parsed body validator.
// The full write path (live DB, RLS, audit) is exercised in
// raw.integration.test.ts.

describe("parseRawParsedWriteBody", () => {
  const valid = {
    parser: "doc_obligation_v1",
    parser_version: "1.0.0",
    extracted: { direction: "payable", amount: "100.00" },
    confidence: 0.4,
  };

  it("accepts a well-formed body and normalizes it", () => {
    expect(parseRawParsedWriteBody(valid)).toEqual({
      parser: "doc_obligation_v1",
      parser_version: "1.0.0",
      extracted: { direction: "payable", amount: "100.00" },
      confidence: 0.4,
    });
  });

  it("defaults confidence to null when omitted", () => {
    const { confidence, ...rest } = valid;
    void confidence;
    expect(parseRawParsedWriteBody(rest).confidence).toBeNull();
  });

  it("treats explicit null confidence as null", () => {
    expect(parseRawParsedWriteBody({ ...valid, confidence: null }).confidence).toBeNull();
  });

  it.each([
    ["non-object body", 42],
    ["null body", null],
    ["missing parser", { ...valid, parser: undefined }],
    ["empty parser", { ...valid, parser: "" }],
    ["missing parser_version", { ...valid, parser_version: undefined }],
    ["missing extracted", { ...valid, extracted: undefined }],
    ["array extracted", { ...valid, extracted: [1, 2] }],
    ["null extracted", { ...valid, extracted: null }],
    ["confidence above 1", { ...valid, confidence: 1.5 }],
    ["confidence below 0", { ...valid, confidence: -0.1 }],
    ["confidence not a number", { ...valid, confidence: "high" }],
  ])("rejects %s with request_body_invalid", (_label, input) => {
    try {
      parseRawParsedWriteBody(input);
      throw new Error("expected parseRawParsedWriteBody to throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) {
        expect(err.code).toBe("request_body_invalid");
        expect(err.statusCode).toBe(400);
      }
    }
  });
});

// F4: the trusted-service HMAC used to sign only the request body, so a
// captured signature could be replayed with a different (unsigned)
// X-Brain-Write-Tenant header and land attacker-chosen content in a victim
// tenant. The signed material now binds the timestamp and write-tenant.
describe("computeServiceAuthSignatureV2 / verifyServiceAuthSignatureV2", () => {
  const secret = "test-secret";
  const body = Buffer.from(JSON.stringify({ parser: "p", parser_version: "1", extracted: {} }));

  function nowSeconds(): string {
    return String(Math.floor(Date.now() / 1000));
  }

  it("verifies a freshly signed request", () => {
    const ts = nowSeconds();
    const sig = computeServiceAuthSignatureV2(secret, ts, "tnt_victim", body);
    expect(verifyServiceAuthSignatureV2(body, sig, ts, "tnt_victim", secret)).toBe(true);
  });

  it("F4 core fix: a signature captured for one tenant does not verify for a different tenant", () => {
    const ts = nowSeconds();
    // Legitimately signed for the caller's own tenant (or no redirect: "").
    const sig = computeServiceAuthSignatureV2(secret, ts, "", body);
    // Replaying it with a victim tenant in X-Brain-Write-Tenant must fail --
    // this is exactly the exploit F4 describes.
    expect(verifyServiceAuthSignatureV2(body, sig, ts, "tnt_victim", secret)).toBe(false);
  });

  it("rejects a signature outside the bounded replay window", () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 301);
    const sig = computeServiceAuthSignatureV2(secret, staleTs, "tnt_a", body);
    expect(verifyServiceAuthSignatureV2(body, sig, staleTs, "tnt_a", secret)).toBe(false);
  });

  it("accepts a signature at the edge of the replay window", () => {
    const edgeTs = String(Math.floor(Date.now() / 1000) - 300);
    const sig = computeServiceAuthSignatureV2(secret, edgeTs, "tnt_a", body);
    expect(verifyServiceAuthSignatureV2(body, sig, edgeTs, "tnt_a", secret)).toBe(true);
  });

  it("rejects a legacy v1-style signature (body-only, no version prefix)", () => {
    const ts = nowSeconds();
    const legacySig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyServiceAuthSignatureV2(body, legacySig, ts, "", secret)).toBe(false);
  });

  it("rejects a missing timestamp header even with an otherwise-correct signature shape", () => {
    const ts = nowSeconds();
    const sig = computeServiceAuthSignatureV2(secret, ts, "tnt_a", body);
    expect(verifyServiceAuthSignatureV2(body, sig, undefined, "tnt_a", secret)).toBe(false);
  });

  it("rejects when the body is tampered with", () => {
    const ts = nowSeconds();
    const sig = computeServiceAuthSignatureV2(secret, ts, "tnt_a", body);
    const tampered = Buffer.from(body.toString() + "x");
    expect(verifyServiceAuthSignatureV2(tampered, sig, ts, "tnt_a", secret)).toBe(false);
  });
});
