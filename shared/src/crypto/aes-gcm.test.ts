import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCredentials, encryptCredentials } from "./aes-gcm.js";

const KEY = randomBytes(32);
const KEY_ID = "test-v1";

describe("encryptCredentials / decryptCredentials", () => {
  it("round-trips a plain credential object", () => {
    const plain = { access_token: "access-sandbox-abc", account_id: "acc_xyz" };
    const { ciphertext, keyId } = encryptCredentials(plain, KEY, KEY_ID);
    expect(keyId).toBe(KEY_ID);
    expect(ciphertext).toBeInstanceOf(Buffer);
    const recovered = decryptCredentials(ciphertext, KEY) as typeof plain;
    expect(recovered.access_token).toBe(plain.access_token);
    expect(recovered.account_id).toBe(plain.account_id);
  });

  it("produces different ciphertext each call (random IV)", () => {
    const plain = { secret: "same" };
    const { ciphertext: c1 } = encryptCredentials(plain, KEY, KEY_ID);
    const { ciphertext: c2 } = encryptCredentials(plain, KEY, KEY_ID);
    expect(c1.equals(c2)).toBe(false);
  });

  it("throws on tampered ciphertext (authTag mismatch)", () => {
    const { ciphertext } = encryptCredentials({ x: 1 }, KEY, KEY_ID);
    const last = ciphertext.length - 1;
    // Flip a bit in the auth tag to trigger a decryption failure.
    if (last >= 0) ciphertext.writeUInt8((ciphertext.readUInt8(last) ^ 0xff) & 0xff, last);
    expect(() => decryptCredentials(ciphertext, KEY)).toThrow();
  });

  it("throws on wrong key", () => {
    const { ciphertext } = encryptCredentials({ x: 1 }, KEY, KEY_ID);
    const wrongKey = randomBytes(32);
    expect(() => decryptCredentials(ciphertext, wrongKey)).toThrow();
  });

  it("throws when ciphertext is too short", () => {
    const tooShort = Buffer.alloc(10);
    expect(() => decryptCredentials(tooShort, KEY)).toThrow("too short");
  });
});
