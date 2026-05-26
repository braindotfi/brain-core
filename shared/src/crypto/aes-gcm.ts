/**
 * AES-256-GCM credential encryption for source secrets.
 *
 * Wire format: iv (12 bytes) || authTag (16 bytes) || ciphertext.
 *
 * Production keys come from Azure Key Vault. The env-var path
 * (BRAIN_SOURCE_CREDENTIAL_KEY) is for staging/dev only.
 * TODO: throw at boot when NODE_ENV=production and env-var path is used.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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
