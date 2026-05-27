import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, PasswordInputError } from "./password.js";

describe("password hashing (scrypt) — RFC 0002 Phase B", () => {
  it("produces the self-describing scrypt$N$r$p$salt$dk format", async () => {
    const hash = await hashPassword("correct horse battery staple");
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBe(1 << 15);
    expect(Number(parts[2])).toBeGreaterThan(0); // r
    expect(Number(parts[3])).toBeGreaterThan(0); // p
    expect(parts[4]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url salt
    expect(parts[5]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url dk
  });

  it("uses a fresh salt per call (same password ⇒ different hashes)", async () => {
    const a = await hashPassword("hunter2");
    const b = await hashPassword("hunter2");
    expect(a).not.toBe(b);
    // ...but both verify.
    expect(await verifyPassword("hunter2", a)).toBe(true);
    expect(await verifyPassword("hunter2", b)).toBe(true);
  });

  it("verifies the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("s3cr3t-pass");
    expect(await verifyPassword("s3cr3t-pass", hash)).toBe(true);
    expect(await verifyPassword("s3cr3t-Pass", hash)).toBe(false);
    expect(await verifyPassword("", hash).catch(() => "threw")).toBe("threw"); // empty throws (input error)
  });

  it("round-trips unicode + long-but-bounded passwords", async () => {
    const pw = "пароль-🔐-Ω-" + "x".repeat(1000);
    const hash = await hashPassword(pw);
    expect(await verifyPassword(pw, hash)).toBe(true);
    expect(await verifyPassword(pw + "!", hash)).toBe(false);
  });

  it.each([
    ["empty string", ""],
    ["wrong prefix", "bcrypt$15$8$1$AAAA$BBBB"],
    ["too few parts", "scrypt$32768$8$1$AAAA"],
    ["too many parts", "scrypt$32768$8$1$AAAA$BBBB$CC"],
    ["non-numeric N", "scrypt$xx$8$1$AAAA$BBBB"],
    ["non-power-of-two N", "scrypt$1000$8$1$AAAA$BBBB"],
    ["zero r", "scrypt$32768$0$1$AAAA$BBBB"],
    ["empty salt segment", "scrypt$32768$8$1$$BBBB"],
    ["garbage", "not-a-hash"],
  ])(
    "verifyPassword returns false (no throw) for malformed stored value: %s",
    async (_label, stored) => {
      await expect(verifyPassword("anything", stored)).resolves.toBe(false);
    },
  );

  it("throws PasswordInputError on empty / over-length / non-string input", async () => {
    await expect(hashPassword("")).rejects.toBeInstanceOf(PasswordInputError);
    await expect(hashPassword("x".repeat(4097))).rejects.toBeInstanceOf(PasswordInputError);
    await expect(hashPassword(undefined as unknown as string)).rejects.toBeInstanceOf(
      PasswordInputError,
    );
    const hash = await hashPassword("ok-password");
    await expect(verifyPassword("x".repeat(4097), hash)).rejects.toBeInstanceOf(PasswordInputError);
  });
});
