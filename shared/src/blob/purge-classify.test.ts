import { describe, expect, it } from "vitest";
import { classifyBlobDeleteError } from "./purge-classify.js";

describe("classifyBlobDeleteError", () => {
  describe("legal_hold (terminal, not retryable)", () => {
    it("Azure BlobImmutableDueToPolicy code", () => {
      const r = classifyBlobDeleteError({ name: "BlobImmutableDueToPolicy", statusCode: 409 });
      expect(r).toMatchObject({ category: "legal_hold", retryable: false });
    });
    it("S3 object-lock surfaced only in the message (403 AccessDenied)", () => {
      // The lock signal in the message must WIN over the 403/AccessDenied auth
      // bucket, else a real hold would be retried forever.
      const r = classifyBlobDeleteError({
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
        message: "Access Denied: object is protected by Object Lock retention",
      });
      expect(r.category).toBe("legal_hold");
      expect(r.retryable).toBe(false);
    });
    it("immutability / WORM / legal hold message variants", () => {
      for (const m of ["immutability policy", "WORM protected", "legal hold active"]) {
        expect(classifyBlobDeleteError({ message: m }).category).toBe("legal_hold");
      }
    });
  });

  describe("transient (retryable)", () => {
    it("S3 SlowDown / 503", () => {
      const r = classifyBlobDeleteError({ name: "SlowDown", $metadata: { httpStatusCode: 503 } });
      expect(r).toMatchObject({ category: "transient", retryable: true, providerCode: "SlowDown" });
    });
    it("HTTP 429 throttling", () => {
      expect(classifyBlobDeleteError({ statusCode: 429 }).category).toBe("transient");
    });
    it("Azure ServerBusy", () => {
      expect(classifyBlobDeleteError({ code: "ServerBusy", statusCode: 503 }).category).toBe(
        "transient",
      );
    });
    it("network errno (ECONNRESET)", () => {
      expect(classifyBlobDeleteError({ code: "ECONNRESET" }).category).toBe("transient");
    });
    it("any 5xx is transient", () => {
      expect(classifyBlobDeleteError({ statusCode: 500 }).retryable).toBe(true);
    });
  });

  describe("authorization (retryable, NEVER a legal hold)", () => {
    it("plain 403 AccessDenied with no lock signal", () => {
      const r = classifyBlobDeleteError({
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
        message: "Access Denied",
      });
      expect(r.category).toBe("authorization");
      expect(r.retryable).toBe(true);
    });
    it("Azure AuthenticationFailed / 401", () => {
      expect(
        classifyBlobDeleteError({ code: "AuthenticationFailed", statusCode: 401 }).category,
      ).toBe("authorization");
    });
  });

  describe("unknown (retryable, conservative)", () => {
    it("an unrecognized error is unknown, not legal_hold", () => {
      const r = classifyBlobDeleteError({ message: "weird teapot error" });
      expect(r.category).toBe("unknown");
      expect(r.retryable).toBe(true);
    });
    it("a non-object error (string) does not throw", () => {
      expect(classifyBlobDeleteError("boom").category).toBe("unknown");
    });
  });
});
