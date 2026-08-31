#!/usr/bin/env node

import { createHash, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptFileWithDataKey, readEnvelope } from "./staging-migration-envelope.mjs";

const KEY_VAULT_API_VERSION = "7.4";
const STORAGE_API_VERSION = "2023-11-03";
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateConfig() {
  const runId = requiredEnv("BRAIN_STAGING_MIGRATION_RUN_ID");
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      "BRAIN_STAGING_MIGRATION_RUN_ID must be 3 to 40 lowercase letters, digits, or hyphens",
    );
  }
  const storageAccount = requiredEnv("BRAIN_STAGING_MIGRATION_STORAGE_ACCOUNT");
  if (!/^braincorestgmig[a-z0-9]{3,9}$/.test(storageAccount)) {
    throw new Error("migration storage account must use the braincorestgmig prefix");
  }
  const vaultUri = requiredEnv("BRAIN_STAGING_MIGRATION_KEY_VAULT_URI").replace(/\/$/, "");
  if (!/^https:\/\/brain-staging-[a-z0-9-]+\.vault\.azure\.net$/.test(vaultUri)) {
    throw new Error("migration Key Vault URI must be an HTTPS brain-staging vault");
  }
  const keyName = requiredEnv("BRAIN_STAGING_MIGRATION_KEY_NAME");
  if (keyName !== "migration-rehearsal-wrap") {
    throw new Error("unexpected migration wrapping key name");
  }
  const resourceId = requiredEnv("BRAIN_STAGING_MIGRATION_STORAGE_RESOURCE_ID");
  const expectedSubscriptionId = requiredEnv("BRAIN_STAGING_MIGRATION_EXPECTED_SUBSCRIPTION_ID");
  if (
    !resourceId.toLowerCase().startsWith(`/subscriptions/${expectedSubscriptionId.toLowerCase()}/`)
  ) {
    throw new Error("migration storage account is not in the expected staging subscription");
  }
  if (/production/i.test(`${resourceId}\n${vaultUri}`)) {
    throw new Error("production resource reference found in staging migration configuration");
  }
  return {
    runId,
    container: `intake-${runId}`,
    storageAccount,
    storageResourceId: resourceId,
    vaultUri,
    keyName,
  };
}

async function managedIdentityToken(resource) {
  const endpoint = requiredEnv("IDENTITY_ENDPOINT");
  const identityHeader = requiredEnv("IDENTITY_HEADER");
  const url = new URL(endpoint);
  url.searchParams.set("api-version", "2019-08-01");
  url.searchParams.set("resource", resource);
  const clientId = process.env.AZURE_CLIENT_ID;
  if (clientId) url.searchParams.set("client_id", clientId);
  const response = await fetch(url, {
    headers: { "X-IDENTITY-HEADER": identityHeader },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`managed identity token request failed with HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("managed identity token response omitted access_token");
  }
  return body.access_token;
}

async function requestJson(url, token, init, expectedStatuses) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `${init?.method ?? "GET"} ${new URL(url).pathname} failed with HTTP ${response.status}`,
    );
  }
  return response.status === 204 ? null : response.json();
}

async function storageRequest(config, token, method, blobName = null, body = undefined) {
  const encodedBlob = blobName
    ?.split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const path = encodedBlob ? `/${config.container}/${encodedBlob}` : `/${config.container}`;
  const query = encodedBlob ? "" : "?restype=container";
  return fetch(`https://${config.storageAccount}.blob.core.windows.net${path}${query}`, {
    method,
    body,
    headers: {
      Authorization: `Bearer ${token}`,
      "x-ms-date": new Date().toUTCString(),
      "x-ms-version": STORAGE_API_VERSION,
      ...(method === "PUT" && !encodedBlob ? { "x-ms-meta-run-id": config.runId } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

function publicKeyFromJwk(jwk) {
  if (jwk?.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    throw new Error("Key Vault response did not contain an RSA public key");
  }
  const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  const der = key.export({ format: "der", type: "spki" });
  return {
    pem: key.export({ format: "pem", type: "spki" }).toString(),
    fingerprint: createHash("sha256").update(der).digest("hex"),
    modulusBytes: Buffer.from(jwk.n, "base64url").length,
  };
}

function requireVersionedKeyId(keyId, config) {
  const expectedPrefix = `${config.vaultUri}/keys/${config.keyName}/`;
  if (!keyId.startsWith(expectedPrefix) || keyId.slice(expectedPrefix.length).includes("/")) {
    throw new Error("key ID is not a version of the staging migration wrapping key");
  }
}

async function prepare(config) {
  const storageToken = await managedIdentityToken("https://storage.azure.com/");
  const existing = await storageRequest(config, storageToken, "HEAD");
  if (existing.status !== 404) {
    throw new Error(
      `per-run container must not already exist; HEAD returned HTTP ${existing.status}`,
    );
  }

  const vaultToken = await managedIdentityToken("https://vault.azure.net");
  const expires = Math.floor(Date.now() / 1000) + 8 * 24 * 60 * 60;
  const created = await requestJson(
    `${config.vaultUri}/keys/${config.keyName}/create?api-version=${KEY_VAULT_API_VERSION}`,
    vaultToken,
    {
      method: "POST",
      body: JSON.stringify({
        kty: "RSA",
        key_size: 3072,
        key_ops: ["wrapKey", "unwrapKey"],
        attributes: { enabled: true, exp: expires },
        tags: { purpose: "staging-migration-rehearsal", run_id: config.runId },
      }),
    },
    [200],
  );
  const keyId = created?.key?.kid;
  if (typeof keyId !== "string") throw new Error("Key Vault response omitted the key version ID");
  requireVersionedKeyId(keyId, config);
  const operations = [...(created.key.key_ops ?? [])].sort();
  if (operations.join(",") !== "unwrapKey,wrapKey") {
    throw new Error("created key version has operations beyond wrapKey and unwrapKey");
  }
  const publicKey = publicKeyFromJwk(created.key);
  if (publicKey.modulusBytes !== 384) throw new Error("created key is not RSA-3072");

  const container = await storageRequest(config, storageToken, "PUT");
  if (container.status !== 201) {
    throw new Error(`per-run container creation failed with HTTP ${container.status}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      summary: "staging_migration_intake_prepared",
      ok: true,
      run_id: config.runId,
      container: config.container,
      key_id: keyId,
      key_fingerprint_sha256: publicKey.fingerprint,
      public_key_pem_base64: Buffer.from(publicKey.pem).toString("base64"),
    })}\n`,
  );
}

async function downloadBlob(config, token, blobName) {
  const response = await storageRequest(config, token, "GET", blobName);
  if (response.status !== 200)
    throw new Error(`canary blob ${blobName} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function deleteBlob(config, token, blobName) {
  const response = await storageRequest(config, token, "DELETE", blobName);
  if (![202, 404].includes(response.status)) {
    throw new Error(`canary blob cleanup for ${blobName} returned HTTP ${response.status}`);
  }
}

async function validateCanary(config) {
  const expectedSha256 = requiredEnv("BRAIN_STAGING_MIGRATION_CANARY_SHA256");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("BRAIN_STAGING_MIGRATION_CANARY_SHA256 must be lowercase SHA-256 hex");
  }
  const expectedKeyId = requiredEnv("BRAIN_STAGING_MIGRATION_KEY_ID");
  requireVersionedKeyId(expectedKeyId, config);
  const storageToken = await managedIdentityToken("https://storage.azure.com/");
  const [ciphertext, envelopeBytes] = await Promise.all([
    downloadBlob(config, storageToken, "canary/probe.enc"),
    downloadBlob(config, storageToken, "canary/probe.envelope.json"),
  ]);
  if (ciphertext.length > 1024 * 1024 || envelopeBytes.length > 64 * 1024) {
    throw new Error("disposable canary exceeds the bounded validation size");
  }

  const directory = await mkdtemp(join(tmpdir(), "brain-staging-migration-canary-"));
  const ciphertextPath = join(directory, "probe.enc");
  const envelopePath = join(directory, "probe.envelope.json");
  const plaintextPath = join(directory, "probe.plaintext");
  try {
    await writeFile(ciphertextPath, ciphertext, { mode: 0o600, flag: "wx" });
    await writeFile(envelopePath, envelopeBytes, { mode: 0o600, flag: "wx" });
    const envelope = await readEnvelope(envelopePath);
    if (envelope.key_id !== expectedKeyId)
      throw new Error("canary envelope key ID is not the approved version");

    const vaultToken = await managedIdentityToken("https://vault.azure.net");
    const key = await requestJson(
      `${expectedKeyId}?api-version=${KEY_VAULT_API_VERSION}`,
      vaultToken,
      undefined,
      [200],
    );
    const publicKey = publicKeyFromJwk(key?.key);
    if (publicKey.fingerprint !== envelope.key_fingerprint_sha256) {
      throw new Error("canary envelope fingerprint does not match Key Vault");
    }
    const unwrapped = await requestJson(
      `${expectedKeyId}/unwrapkey?api-version=${KEY_VAULT_API_VERSION}`,
      vaultToken,
      {
        method: "POST",
        body: JSON.stringify({
          alg: "RSA-OAEP-256",
          value: envelope.wrapped_data_key.toString("base64url"),
        }),
      },
      [200],
    );
    if (typeof unwrapped?.value !== "string")
      throw new Error("Key Vault unwrap response omitted value");
    const dataKey = Buffer.from(unwrapped.value, "base64url");
    const result = await decryptFileWithDataKey({
      inputPath: ciphertextPath,
      outputPath: plaintextPath,
      envelopePath,
      dataKey,
    });
    if (result.plaintextSha256 !== expectedSha256) {
      throw new Error("decrypted canary SHA-256 does not match the source receipt");
    }
    await Promise.all([
      deleteBlob(config, storageToken, "canary/probe.enc"),
      deleteBlob(config, storageToken, "canary/probe.envelope.json"),
    ]);
    process.stdout.write(
      `${JSON.stringify({
        summary: "staging_migration_canary_validated",
        ok: true,
        run_id: config.runId,
        key_id: expectedKeyId,
        key_fingerprint_sha256: result.keyFingerprintSha256,
        plaintext_sha256: result.plaintextSha256,
        canary_cleanup: true,
      })}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function cleanup(config) {
  const confirmation = requiredEnv("BRAIN_STAGING_MIGRATION_CLEANUP_CONFIRMATION");
  if (confirmation !== `DELETE-${config.runId}`) {
    throw new Error("cleanup confirmation does not match the run ID");
  }
  const keyId = requiredEnv("BRAIN_STAGING_MIGRATION_KEY_ID");
  requireVersionedKeyId(keyId, config);
  const storageToken = await managedIdentityToken("https://storage.azure.com/");
  const deleted = await storageRequest(config, storageToken, "DELETE");
  if (![202, 404].includes(deleted.status)) {
    throw new Error(`per-run container deletion failed with HTTP ${deleted.status}`);
  }
  let afterDeleteStatus = deleted.status === 404 ? 404 : 0;
  for (let attempt = 0; attempt < 10 && afterDeleteStatus !== 404; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    afterDeleteStatus = (await storageRequest(config, storageToken, "HEAD")).status;
  }
  if (afterDeleteStatus !== 404) {
    throw new Error("per-run container still resolves after deletion; key version remains enabled");
  }

  const vaultToken = await managedIdentityToken("https://vault.azure.net");
  await requestJson(
    `${keyId}?api-version=${KEY_VAULT_API_VERSION}`,
    vaultToken,
    { method: "PATCH", body: JSON.stringify({ attributes: { enabled: false } }) },
    [200],
  );
  process.stdout.write(
    `${JSON.stringify({
      summary: "staging_migration_intake_cleaned",
      ok: true,
      run_id: config.runId,
      container_deleted: true,
      key_version_disabled: true,
      key_id: keyId,
    })}\n`,
  );
}

async function main() {
  const mode = requiredEnv("BRAIN_STAGING_MIGRATION_MODE");
  const config = validateConfig();
  if (mode === "prepare") return prepare(config);
  if (mode === "validate-canary") return validateCanary(config);
  if (mode === "cleanup") return cleanup(config);
  throw new Error("BRAIN_STAGING_MIGRATION_MODE must be prepare, validate-canary, or cleanup");
}

main().catch((error) => {
  process.stderr.write(
    `staging-migration-intake: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
