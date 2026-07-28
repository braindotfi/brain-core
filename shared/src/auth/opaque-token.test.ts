import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { newSecretToken, hashToken } from "./opaque-token.js";

describe("newSecretToken / hashToken", () => {
  it("mints a unique base64url token each call", () => {
    const a = newSecretToken();
    const b = newSecretToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashToken is a deterministic sha256 hex digest, matching the previous per-service copies", () => {
    const token = "fixed-example-token";
    expect(hashToken(token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken("a-different-token"));
  });
});
