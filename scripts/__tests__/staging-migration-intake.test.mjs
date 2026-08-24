import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  decryptFileWithDataKey,
  encryptFile,
  readEnvelope,
} from "../ops/staging-migration-envelope.mjs";

const read = (path) => readFile(path, "utf8");

test("migration envelope encrypts with AES-256-GCM and RSA-OAEP-256", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brain-migration-envelope-"));
  try {
    const input = join(directory, "input");
    const ciphertext = join(directory, "ciphertext");
    const envelopePath = join(directory, "envelope.json");
    const publicKeyPath = join(directory, "public.pem");
    const output = join(directory, "output");
    const plaintext = Buffer.concat([
      Buffer.from("migration-canary:"),
      Buffer.alloc(256 * 1024, 0x5a),
    ]);
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    await writeFile(input, plaintext, { mode: 0o600 });
    await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), {
      mode: 0o600,
    });

    const written = await encryptFile({
      inputPath: input,
      outputPath: ciphertext,
      envelopePath,
      publicKeyPath,
      keyId: "https://brain-staging-kv.vault.azure.net/keys/migration-rehearsal-wrap/version-one",
    });
    assert.equal(written.content_algorithm, "AES-256-GCM");
    assert.equal(written.wrap_algorithm, "RSA-OAEP-256");
    assert.match(written.key_fingerprint_sha256, /^[0-9a-f]{64}$/);
    assert.equal(written.ciphertext_bytes, plaintext.length);

    const parsed = await readEnvelope(envelopePath);
    const dataKey = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      parsed.wrapped_data_key,
    );
    const result = await decryptFileWithDataKey({
      inputPath: ciphertext,
      outputPath: output,
      envelopePath,
      dataKey,
    });
    assert.deepEqual(await readFile(output), plaintext);
    assert.match(result.plaintextSha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration envelope fails closed on ciphertext tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brain-migration-tamper-"));
  try {
    const input = join(directory, "input");
    const ciphertext = join(directory, "ciphertext");
    const envelopePath = join(directory, "envelope.json");
    const publicKeyPath = join(directory, "public.pem");
    const output = join(directory, "output");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    await writeFile(input, "sensitive fixture", { mode: 0o600 });
    await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), {
      mode: 0o600,
    });
    await encryptFile({
      inputPath: input,
      outputPath: ciphertext,
      envelopePath,
      publicKeyPath,
      keyId: "https://brain-staging-kv.vault.azure.net/keys/migration-rehearsal-wrap/version-two",
    });
    const parsed = await readEnvelope(envelopePath);
    const dataKey = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      parsed.wrapped_data_key,
    );
    const damaged = await readFile(ciphertext);
    damaged[0] ^= 0xff;
    await writeFile(ciphertext, damaged);
    await assert.rejects(
      decryptFileWithDataKey({ inputPath: ciphertext, outputPath: output, envelopePath, dataKey }),
    );
    await assert.rejects(readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staging migration Terraform isolates encrypted intake and least-privilege upload", async () => {
  const [main, variables, route, intake, upload, inventory, workflow, dockerfile] =
    await Promise.all([
      read("infra/staging-migration/main.tf"),
      read("infra/staging-migration/variables.tf"),
      read("infra/staging-migration-route/main.tf"),
      read("scripts/ops/staging-migration-intake.mjs"),
      read("scripts/ops/staging-migration-upload.sh"),
      read("scripts/ops/inventory-azure-vm-managed-identity.sh"),
      read(".github/workflows/ops-staging-migration-intake.yml"),
      read("Dockerfile"),
    ]);

  assert.match(main, /key_size\s+= 3072/);
  assert.match(main, /key_opts\s+= \["wrapKey", "unwrapKey"\]/);
  assert.match(main, /shared_access_key_enabled\s+= false/);
  assert.match(main, /public_network_access_enabled\s+= false/);
  assert.match(main, /https_traffic_only_enabled\s+= true/);
  assert.match(
    main,
    /delete_after_days_since_modification_greater_than = var\.migration_retention_days/,
  );
  assert.match(main, /privatelink\.blob\.core\.windows\.net/);
  assert.match(main, /blobs\/add\/action/);
  assert.match(main, /blobs\/write/);
  const uploaderRole = main.match(
    /resource "azurerm_role_definition" "direct_uploader"[\s\S]*?\n}/,
  )?.[0];
  assert.ok(uploaderRole);
  assert.doesNotMatch(uploaderRole, /blobs\/read|blobs\/delete|containers\/blobs\/list/);
  assert.match(variables, /migration_retention_days >= 1 && var\.migration_retention_days <= 7/);
  assert.match(variables, /source_upload_auth_mode != "managed_identity"/);
  assert.match(variables, /source_upload_auth_mode != "user_delegation_sas"/);

  assert.match(route, /resource "azurerm_private_endpoint" "source_migration_blob"/);
  assert.match(route, /private_connection_resource_id = var\.migration_storage_account_id/);
  assert.doesNotMatch(route, /azurerm_virtual_network_peering/);
  assert.match(route, /resource "azurerm_private_dns_zone_virtual_network_link" "source_blob"/);
  assert.match(route, /condition\s+= var\.source_uses_azure_provided_dns/);

  assert.match(intake, /key_size: 3072/);
  assert.match(intake, /key_ops: \["wrapKey", "unwrapKey"\]/);
  assert.match(intake, /\/create\?api-version=/);
  assert.match(intake, /\/unwrapkey\?api-version=/);
  assert.match(intake, /container still resolves after deletion; key version remains enabled/);
  assert.ok(
    intake.indexOf('storageRequest(config, storageToken, "DELETE")') <
      intake.indexOf("attributes: { enabled: false }"),
  );

  assert.match(upload, /--permissions cw/);
  assert.match(upload, /MIGRATION_MEASURED_TRANSFER_SECONDS/);
  assert.match(upload, /lifetime > 12 \* 3600/);
  assert.match(upload, /Math\.max\(3600, Math\.ceil\(measured \* 0\.25\)\)/);
  assert.match(upload, /AZURE_STORAGE_SAS_TOKEN=\$\(<"\$MIGRATION_SAS_FILE"\)/);
  assert.doesNotMatch(upload, /printf[^\n]*AZURE_STORAGE_SAS_TOKEN/);
  assert.match(upload, /resolve exclusively to private IPv4 addresses/);
  assert.match(upload, /allowSharedKeyAccess/);
  assert.match(upload, /actual_key_fingerprint/);
  assert.match(upload, /public key is not RSA-3072/);
  assert.match(inventory, /az vm identity show --ids/);
  assert.match(inventory, /candidate-found-canary-still-required/);
  assert.match(inventory, /client_id: \.value\.clientId/);
  assert.match(upload, /MIGRATION_MANAGED_IDENTITY_CLIENT_ID/);

  assert.match(workflow, /environment: azure-staging-rehearsal/);
  assert.match(workflow, /AZURE_STAGING_CLIENT_ID/);
  assert.match(workflow, /DELETE-\$RUN_ID/);
  assert.doesNotMatch(workflow, /AZURE_CLIENT_ID\b/);
  assert.match(dockerfile, /staging-migration-envelope\.mjs/);
  assert.match(dockerfile, /staging-migration-intake\.mjs/);
});

test("Sanket SAS helper writes a bounded create-and-write token only to a mode-0600 file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brain-migration-sas-"));
  const runDirectory = join(directory, "run");
  const binDirectory = join(directory, "bin");
  const argsFile = join(directory, "az-args");
  try {
    await Promise.all([mkdir(runDirectory, { mode: 0o700 }), mkdir(binDirectory, { mode: 0o700 })]);
    writeFileSync(
      join(binDirectory, "getent"),
      "#!/usr/bin/env bash\nprintf '10.42.0.7 STREAM fixture\\n'\n",
      { mode: 0o700 },
    );
    writeFileSync(
      join(binDirectory, "stat"),
      "#!/usr/bin/env bash\nif [[ \"$*\" == *upload.sas* ]]; then printf '600\\n'; else printf '700\\n'; fi\n",
      { mode: 0o700 },
    );
    writeFileSync(
      join(binDirectory, "az"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$AZ_ARGS_FILE"
if [[ "$*" == "storage account show"* ]]; then
  printf '{"publicNetworkAccess":"Disabled","allowSharedKeyAccess":false,"enableHttpsTrafficOnly":true}\n'
elif [[ "$*" == "storage container generate-sas"* ]]; then
  printf 'fixture-secret-sas\n'
else
  printf 'unexpected az invocation\n' >&2
  exit 2
fi
`,
      { mode: 0o700 },
    );
    chmodSync(runDirectory, 0o700);
    const result = spawnSync("bash", ["scripts/ops/staging-migration-upload.sh", "issue-sas"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        AZ_ARGS_FILE: argsFile,
        MIGRATION_RUN_DIR: runDirectory,
        MIGRATION_RUN_ID: "run-123",
        MIGRATION_STORAGE_ACCOUNT: "brainstgmigfixture",
        MIGRATION_MEASURED_TRANSFER_SECONDS: "7200",
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /fixture-secret-sas/);
    assert.equal(await readFile(join(runDirectory, "upload.sas"), "utf8"), "fixture-secret-sas\n");
    const args = await readFile(argsFile, "utf8");
    assert.match(args, /--as-user/);
    assert.match(args, /--auth-mode login/);
    assert.match(args, /--https-only/);
    assert.equal(args.match(/--permissions ([a-z]+)/)?.[1], "cw");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
