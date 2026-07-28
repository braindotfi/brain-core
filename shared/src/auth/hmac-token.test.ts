import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintHmacToken, verifyHmacToken } from "./hmac-token.js";

const SECRET = "test-secret-do-not-use-in-prod";

describe("HMAC token primitive (mint + verify)", () => {
  it("round-trips the payload and nonce", () => {
    const minted = mintHmacToken({
      secret: SECRET,
      aud: "auth.session",
      payload: { tenantId: "tnt_abc", memberId: "mem_1" },
      ttlSeconds: 600,
    });
    expect(minted.token.split(".")).toHaveLength(3);
    expect(minted.token.startsWith("v1.")).toBe(true);

    const result = verifyHmacToken<{ tenantId: string; memberId: string }>({
      token: minted.token,
      secret: SECRET,
      aud: "auth.session",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.payload).toEqual({ tenantId: "tnt_abc", memberId: "mem_1" });
    expect(result.nonce).toBe(minted.nonce);
  });

  it("rejects a tampered payload", () => {
    const minted = mintHmacToken({
      secret: SECRET,
      aud: "auth.session",
      payload: { role: "admin" },
      ttlSeconds: 600,
    });
    const [version, encoded] = minted.token.split(".");
    const tamperedEnvelope = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
    tamperedEnvelope.payload.role = "superadmin";
    const tamperedEncoded = Buffer.from(JSON.stringify(tamperedEnvelope), "utf8").toString(
      "base64url",
    );
    // Reuse the original signature: any payload edit invalidates it.
    const originalSignature = minted.token.split(".")[2];
    const tampered = `${version}.${tamperedEncoded}.${originalSignature}`;

    const result = verifyHmacToken({ token: tampered, secret: SECRET, aud: "auth.session" });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired token", () => {
    const nowMs = Date.now();
    const minted = mintHmacToken({
      secret: SECRET,
      aud: "auth.session",
      payload: {},
      ttlSeconds: 60,
      nowMs,
    });
    const result = verifyHmacToken({
      token: minted.token,
      secret: SECRET,
      aud: "auth.session",
      nowMs: nowMs + 61_000,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token minted for a different audience", () => {
    const minted = mintHmacToken({
      secret: SECRET,
      aud: "auth.session",
      payload: {},
      ttlSeconds: 600,
    });
    const result = verifyHmacToken({ token: minted.token, secret: SECRET, aud: "auth.csrf" });
    expect(result).toEqual({ ok: false, reason: "wrong_audience" });
  });

  it("rejects a malformed token", () => {
    expect(verifyHmacToken({ token: "not-a-token", secret: SECRET, aud: "auth.session" })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyHmacToken({ token: "v2.abc.def", secret: SECRET, aud: "auth.session" })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("signs the version prefix, not just the envelope (finding 8)", () => {
    const minted = mintHmacToken({
      secret: SECRET,
      aud: "auth.session",
      payload: {},
      ttlSeconds: 600,
    });
    const [version, encoded, signature] = minted.token.split(".");
    const versionExclusiveSig = createHmac("sha256", SECRET).update(encoded!).digest("base64url");
    const versionInclusiveSig = createHmac("sha256", SECRET)
      .update(`${version}.${encoded}`)
      .digest("base64url");
    // The MAC must cover the version prefix, not just the envelope, or a
    // future v2 sharing this secret and envelope layout could accept a v1
    // token's <env>.<sig> pair resubmitted with the version byte swapped.
    expect(signature).toBe(versionInclusiveSig);
    expect(signature).not.toBe(versionExclusiveSig);
  });

  it("rejects a version-swapped token", () => {
    const minted = mintHmacToken({
      secret: SECRET,
      aud: "auth.session",
      payload: { role: "admin" },
      ttlSeconds: 600,
    });
    const [, encoded, signature] = minted.token.split(".");
    const swapped = `v2.${encoded}.${signature}`;

    const result = verifyHmacToken({ token: swapped, secret: SECRET, aud: "auth.session" });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a signature produced with a different secret", () => {
    const minted = mintHmacToken({
      secret: SECRET,
      aud: "auth.session",
      payload: {},
      ttlSeconds: 600,
    });
    const result = verifyHmacToken({
      token: minted.token,
      secret: "a-different-secret",
      aud: "auth.session",
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });
});
