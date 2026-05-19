import { describe, expect, it } from "vitest";
import { sanitizeRequestId } from "./request-id.js";

describe("sanitizeRequestId", () => {
  it("accepts well-formed client-supplied IDs", () => {
    expect(sanitizeRequestId("req_01HQ7K3ABCDEFGHJKMNPQRSTV")).toBe(
      "req_01HQ7K3ABCDEFGHJKMNPQRSTV",
    );
    expect(sanitizeRequestId("support-ticket-1234")).toBe("support-ticket-1234");
  });

  it("rejects non-string values", () => {
    expect(sanitizeRequestId(undefined)).toBeNull();
    expect(sanitizeRequestId(42)).toBeNull();
    expect(sanitizeRequestId(["a", "b"])).toBeNull();
  });

  it("rejects empty and oversized strings", () => {
    expect(sanitizeRequestId("")).toBeNull();
    expect(sanitizeRequestId("x".repeat(129))).toBeNull();
  });

  it("rejects disallowed characters", () => {
    expect(sanitizeRequestId("req id with spaces")).toBeNull();
    expect(sanitizeRequestId("<script>")).toBeNull();
    expect(sanitizeRequestId("req\n01")).toBeNull();
  });

  it("permits the characters in Brain ID shapes", () => {
    expect(sanitizeRequestId("req_01HQ7K3.ABC:DEF-123")).toBe("req_01HQ7K3.ABC:DEF-123");
  });
});
