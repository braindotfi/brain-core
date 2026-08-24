#!/usr/bin/env node

import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FORMAT = "brain-staging-migration-envelope-v1";

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${field} must be unpadded base64url`);
  }
  return Buffer.from(value, "base64url");
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function parseEnvelope(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("envelope must be an object");
  }
  if (value.format !== FORMAT) throw new Error(`unsupported envelope format: ${value.format}`);
  if (value.content_algorithm !== "AES-256-GCM") {
    throw new Error(`unsupported content algorithm: ${value.content_algorithm}`);
  }
  if (value.wrap_algorithm !== "RSA-OAEP-256") {
    throw new Error(`unsupported wrap algorithm: ${value.wrap_algorithm}`);
  }
  const ciphertextBytes = value.ciphertext_bytes;
  if (!Number.isSafeInteger(ciphertextBytes) || ciphertextBytes < 0) {
    throw new Error("ciphertext_bytes must be a non-negative safe integer");
  }
  const ciphertextSha256 = requireString(value.ciphertext_sha256, "ciphertext_sha256");
  if (!/^[0-9a-f]{64}$/.test(ciphertextSha256)) {
    throw new Error("ciphertext_sha256 must be lowercase SHA-256 hex");
  }
  const keyFingerprint = requireString(value.key_fingerprint_sha256, "key_fingerprint_sha256");
  if (!/^[0-9a-f]{64}$/.test(keyFingerprint)) {
    throw new Error("key_fingerprint_sha256 must be lowercase SHA-256 hex");
  }
  return {
    format: FORMAT,
    key_id: requireString(value.key_id, "key_id"),
    key_fingerprint_sha256: keyFingerprint,
    content_algorithm: "AES-256-GCM",
    wrap_algorithm: "RSA-OAEP-256",
    iv: decodeBase64Url(value.iv, "iv"),
    authentication_tag: decodeBase64Url(value.authentication_tag, "authentication_tag"),
    wrapped_data_key: decodeBase64Url(value.wrapped_data_key, "wrapped_data_key"),
    ciphertext_sha256: ciphertextSha256,
    ciphertext_bytes: ciphertextBytes,
  };
}

async function writeChunk(handle, chunk) {
  if (chunk.length > 0) await handle.write(chunk);
}

export async function encryptFile({ inputPath, outputPath, envelopePath, publicKeyPath, keyId }) {
  requireString(inputPath, "inputPath");
  requireString(outputPath, "outputPath");
  requireString(envelopePath, "envelopePath");
  requireString(keyId, "keyId");

  const publicKeyPem = await readFile(publicKeyPath);
  const publicKey = createPublicKey(publicKeyPem);
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    publicKey.asymmetricKeyDetails?.modulusLength !== 3072
  ) {
    throw new Error("public key must be RSA-3072");
  }
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256").update(publicKeyDer).digest("hex");
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const wrappedDataKey = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    dataKey,
  );
  dataKey.fill(0);

  const partialOutput = `${outputPath}.partial-${process.pid}`;
  const ciphertextHash = createHash("sha256");
  let ciphertextBytes = 0;
  const output = await open(partialOutput, "wx", 0o600);
  try {
    for await (const chunk of createReadStream(inputPath)) {
      const encrypted = cipher.update(chunk);
      ciphertextHash.update(encrypted);
      ciphertextBytes += encrypted.length;
      await writeChunk(output, encrypted);
    }
    const final = cipher.final();
    ciphertextHash.update(final);
    ciphertextBytes += final.length;
    await writeChunk(output, final);
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(partialOutput, { force: true });
    throw error;
  }
  await output.close();
  await rename(partialOutput, outputPath);

  const envelope = {
    format: FORMAT,
    key_id: keyId,
    key_fingerprint_sha256: fingerprint,
    content_algorithm: "AES-256-GCM",
    wrap_algorithm: "RSA-OAEP-256",
    iv: encodeBase64Url(iv),
    authentication_tag: encodeBase64Url(cipher.getAuthTag()),
    wrapped_data_key: encodeBase64Url(wrappedDataKey),
    ciphertext_sha256: ciphertextHash.digest("hex"),
    ciphertext_bytes: ciphertextBytes,
  };
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return envelope;
}

export async function decryptFileWithDataKey({ inputPath, outputPath, envelopePath, dataKey }) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) {
    throw new Error("dataKey must be exactly 32 bytes");
  }
  const envelope = parseEnvelope(JSON.parse(await readFile(envelopePath, "utf8")));
  const partialOutput = `${outputPath}.partial-${process.pid}`;
  const decipher = createDecipheriv("aes-256-gcm", dataKey, envelope.iv);
  decipher.setAuthTag(envelope.authentication_tag);
  const ciphertextHash = createHash("sha256");
  const plaintextHash = createHash("sha256");
  let ciphertextBytes = 0;
  let plaintextBytes = 0;
  const output = await open(partialOutput, "wx", 0o600);
  try {
    for await (const chunk of createReadStream(inputPath)) {
      ciphertextHash.update(chunk);
      ciphertextBytes += chunk.length;
      const plaintext = decipher.update(chunk);
      plaintextHash.update(plaintext);
      plaintextBytes += plaintext.length;
      await writeChunk(output, plaintext);
    }
    const final = decipher.final();
    plaintextHash.update(final);
    plaintextBytes += final.length;
    await writeChunk(output, final);
    if (ciphertextBytes !== envelope.ciphertext_bytes) {
      throw new Error("ciphertext byte count does not match envelope");
    }
    if (ciphertextHash.digest("hex") !== envelope.ciphertext_sha256) {
      throw new Error("ciphertext SHA-256 does not match envelope");
    }
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(partialOutput, { force: true });
    throw error;
  } finally {
    dataKey.fill(0);
  }
  await output.close();
  await rename(partialOutput, outputPath);
  return {
    keyId: envelope.key_id,
    keyFingerprintSha256: envelope.key_fingerprint_sha256,
    plaintextSha256: plaintextHash.digest("hex"),
    plaintextBytes,
  };
}

export async function readEnvelope(envelopePath) {
  return parseEnvelope(JSON.parse(await readFile(envelopePath, "utf8")));
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    values.set(name.slice(2), value);
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command !== "encrypt") {
    throw new Error(
      "usage: staging-migration-envelope.mjs encrypt --input FILE --output FILE --envelope FILE --public-key FILE --key-id URI",
    );
  }
  const envelope = await encryptFile({
    inputPath: values.get("input"),
    outputPath: values.get("output"),
    envelopePath: values.get("envelope"),
    publicKeyPath: values.get("public-key"),
    keyId: values.get("key-id"),
  });
  process.stdout.write(
    `${JSON.stringify({
      encrypted: true,
      key_id: envelope.key_id,
      key_fingerprint_sha256: envelope.key_fingerprint_sha256,
      ciphertext_sha256: envelope.ciphertext_sha256,
      ciphertext_bytes: envelope.ciphertext_bytes,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `staging-migration-envelope: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
