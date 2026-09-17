#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAddress, keccak256 } from "viem";

process.umask(0o077);

const FIXED_CHALLENGE = Buffer.from(
  "brain-x402-key-vault-premium-restore-drill-v1\nchain-id=84532\n",
  "utf8",
);

function fail(message) {
  throw new Error(message);
}

function azJson(args) {
  const output = execFileSync("az", [...args, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function b64urlToBuffer(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function bufferToB64url(value) {
  return value.toString("base64url");
}

function assertHsmSignOnly(key, label) {
  if (key?.key?.kty !== "EC-HSM") fail(`${label} key type is not EC-HSM`);
  if (key?.key?.crv !== "P-256K") fail(`${label} curve is not P-256K`);
  const operations = [...(key.key.keyOps ?? [])].sort();
  if (operations.length !== 1 || operations[0] !== "sign") {
    fail(`${label} key operations are not exactly sign`);
  }
  if (key.attributes?.enabled !== true) fail(`${label} key is disabled`);
}

function publicEvidence(key) {
  const x = b64urlToBuffer(key.key.x);
  const y = b64urlToBuffer(key.key.y);
  if (x.length !== 32 || y.length !== 32) fail("unexpected P-256K public coordinate length");
  const uncompressed = Buffer.concat([Buffer.from([4]), x, y]);
  const address = getAddress(`0x${keccak256(uncompressed).slice(-40)}`);
  const fingerprint = createHash("sha256")
    .update(Buffer.concat([Buffer.from("P-256K\0"), x, y]))
    .digest("hex");
  return { address, fingerprint, x: key.key.x, y: key.key.y };
}

function verifyAzureSignature(key, signatureValue) {
  const publicKey = createPublicKey({
    key: { kty: "EC", crv: "secp256k1", x: key.key.x, y: key.key.y },
    format: "jwk",
  });
  const signature = b64urlToBuffer(signatureValue);
  if (signature.length !== 64) fail("Azure ES256K signature is not a 64-byte P1363 value");
  return verify(
    "sha256",
    FIXED_CHALLENGE,
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    signature,
  );
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) fail("arguments must be --name value pairs");
    values.set(name.slice(2), value);
  }
  const required = ["source-key-id", "restore-vault", "receipt"];
  for (const name of required) {
    if (!values.has(name)) fail(`missing --${name}`);
  }
  return Object.fromEntries(values);
}

const args = parseArgs(process.argv.slice(2));
const sourceKeyId = args["source-key-id"];
const restoreVaultName = args["restore-vault"];
const receiptPath = args.receipt;
if (!/^https:\/\/[^/]+\.vault\.azure\.net\/keys\/[^/]+\/[^/]+$/.test(sourceKeyId)) {
  fail("source key must be an exact versioned Key Vault URI");
}
if (restoreVaultName !== "brain-x402-restore-kv") fail("restore vault name is not approved");

const runDirectory = mkdtempSync(join(tmpdir(), "brain-x402-kv-drill-"));
const backupPath = join(runDirectory, "seller-key.backup");
try {
  const sourceVaultName = new URL(sourceKeyId).hostname.split(".")[0];
  const [sourceVault, restoreVault] = [sourceVaultName, restoreVaultName].map((name) =>
    azJson(["keyvault", "show", "--name", name]),
  );
  const subscriptionFromId = (id) => id.split("/")[2]?.toLowerCase();
  if (subscriptionFromId(sourceVault.id) !== subscriptionFromId(restoreVault.id)) {
    fail("source and restore vaults are not in the same subscription");
  }
  if (sourceVault.location.toLowerCase() !== restoreVault.location.toLowerCase()) {
    fail("source and restore vaults are not in the same Azure geography");
  }
  if (sourceVault.properties?.sku?.name?.toLowerCase() !== "premium") {
    fail("source vault is not Premium");
  }
  if (restoreVault.properties?.sku?.name?.toLowerCase() !== "premium") {
    fail("restore vault is not Premium");
  }

  const sourceKey = azJson(["keyvault", "key", "show", "--id", sourceKeyId]);
  assertHsmSignOnly(sourceKey, "source");
  const sourceEvidence = publicEvidence(sourceKey);

  execFileSync(
    "az",
    ["keyvault", "key", "backup", "--id", sourceKeyId, "--file", backupPath, "--output", "none"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (statSync(backupPath).size === 0) fail("backup is empty");
  chmodSync(backupPath, 0o600);
  if ((statSync(backupPath).mode & 0o777) !== 0o600) fail("backup mode is not 0600");

  azJson(["keyvault", "key", "restore", "--vault-name", restoreVaultName, "--file", backupPath]);
  const restoredKey = azJson([
    "keyvault",
    "key",
    "show",
    "--vault-name",
    restoreVaultName,
    "--name",
    "brain-x402-sepolia-seller",
  ]);
  assertHsmSignOnly(restoredKey, "restored");
  const restoredEvidence = publicEvidence(restoredKey);
  if (sourceEvidence.fingerprint !== restoredEvidence.fingerprint) {
    fail("restored public-key fingerprint does not match source");
  }
  if (sourceEvidence.address !== restoredEvidence.address) {
    fail("restored EVM address does not match source");
  }

  const digest = bufferToB64url(createHash("sha256").update(FIXED_CHALLENGE).digest());
  const sourceSignature = azJson([
    "keyvault",
    "key",
    "sign",
    "--id",
    sourceKeyId,
    "--algorithm",
    "ES256K",
    "--digest",
    digest,
  ]);
  const restoredSignature = azJson([
    "keyvault",
    "key",
    "sign",
    "--id",
    restoredKey.key.kid,
    "--algorithm",
    "ES256K",
    "--digest",
    digest,
  ]);
  const sourceSignatureVerified = verifyAzureSignature(sourceKey, sourceSignature.value);
  const restoredSignatureVerified = verifyAzureSignature(restoredKey, restoredSignature.value);
  if (!sourceSignatureVerified || !restoredSignatureVerified)
    fail("fixed challenge verification failed");

  mkdirSync(dirname(receiptPath), { recursive: true });
  const receipt = {
    schema: "brain.x402.key_vault_restore_drill.v1",
    completed_at: new Date().toISOString(),
    chain_id: 84532,
    address_classification: "x402_sepolia_bootstrap_only",
    source_key_id: sourceKey.key.kid,
    restored_key_id: restoredKey.key.kid,
    public_key_fingerprint_sha256: sourceEvidence.fingerprint,
    seller_address: sourceEvidence.address,
    fixed_challenge_sha256: createHash("sha256").update(FIXED_CHALLENGE).digest("hex"),
    source_signature_verified: sourceSignatureVerified,
    restored_signature_verified: restoredSignatureVerified,
    same_subscription: true,
    same_geography: true,
    witnessed_by: ["Damon", "Sanket"],
    mainnet_approved: false,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ ok: true, receipt: receiptPath, seller_address: receipt.seller_address })}\n`,
  );
} finally {
  rmSync(runDirectory, { recursive: true, force: true });
}
