import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeEnvCredentialKey, decryptCredentials, encryptCredentials } from "./aes-gcm.js";

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

describe("decodeEnvCredentialKey — production fail-closed guard", () => {
  const ENV_KEY_B64 = randomBytes(32).toString("base64");

  it("returns undefined when env-var is unset (any environment)", () => {
    expect(decodeEnvCredentialKey({ envVarKey: undefined, nodeEnv: "production" })).toBeUndefined();
    expect(decodeEnvCredentialKey({ envVarKey: undefined, nodeEnv: "development" })).toBeUndefined();
  });

  it("decodes the env-var in non-production environments", () => {
    const buf = decodeEnvCredentialKey({ envVarKey: ENV_KEY_B64, nodeEnv: "development" });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf?.length).toBe(32);
  });

  it("throws in production when the env-var path is used (Key Vault required)", () => {
    expect(() =>
      decodeEnvCredentialKey({ envVarKey: ENV_KEY_B64, nodeEnv: "production" }),
    ).toThrow(/forbidden in NODE_ENV=production/);
  });

  it("does not throw in production when the env-var is unset (caller decides)", () => {
    expect(() => decodeEnvCredentialKey({ envVarKey: undefined, nodeEnv: "production" })).not.toThrow();
  });
});
