/**
 * AES-256-GCM credential encryption for source secrets.
 *
 * Wire format: iv (12 bytes) || authTag (16 bytes) || ciphertext.
 *
 * Production keys come from Azure Key Vault. The env-var path
 * (BRAIN_SOURCE_CREDENTIAL_KEY) is for staging/dev only — guarded at boot via
 * {@link decodeEnvCredentialKey} so a production boot that tries to use it
 * fails closed instead of silently encrypting under a weak/env-only key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Decode the BRAIN_SOURCE_CREDENTIAL_KEY env-var into a key buffer. In
 * NODE_ENV=production this path is forbidden — production must source the key
 * from a real KMS (Azure Key Vault); the env-var path is for staging/dev. Throws
 * in production if the env-var is set; returns `undefined` when the env-var is
 * unset (the caller decides whether running without encryption is acceptable —
 * which it is NOT in production).
 */
export function decodeEnvCredentialKey(opts: {
  envVarKey: string | undefined;
  nodeEnv: string | undefined;
}): Buffer | undefined {
  if (opts.envVarKey === undefined) return undefined;
  if (opts.nodeEnv === "production") {
    throw new Error(
      "aes-gcm: BRAIN_SOURCE_CREDENTIAL_KEY env-var path is forbidden in NODE_ENV=production; source the key from Azure Key Vault",
    );
  }
  return Buffer.from(opts.envVarKey, "base64");
}

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MIN_CIPHERTEXT_BYTES = IV_BYTES + AUTH_TAG_BYTES + 1;

export function encryptCredentials(
  plain: object,
  key: Buffer,
  keyId: string,
): { ciphertext: Buffer; keyId: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plainBytes = Buffer.from(JSON.stringify(plain), "utf8");
  const encrypted = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([iv, authTag, encrypted]), keyId };
}

export function decryptCredentials(ciphertext: Buffer, key: Buffer): object {
  if (ciphertext.length < MIN_CIPHERTEXT_BYTES) {
    throw new Error("aes-gcm: ciphertext too short");
  }
  const iv = ciphertext.subarray(0, IV_BYTES);
  const authTag = ciphertext.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const encrypted = ciphertext.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as object;
}
