#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  staging-migration-upload.sh issue-sas
  staging-migration-upload.sh canary

Required for both commands:
  MIGRATION_RUN_DIR, MIGRATION_RUN_ID, MIGRATION_STORAGE_ACCOUNT

issue-sas also requires:
  MIGRATION_MEASURED_TRANSFER_SECONDS

canary also requires:
  MIGRATION_AUTH_MODE (managed-identity or user-delegation-sas)
  MIGRATION_PUBLIC_KEY_FILE, MIGRATION_KEY_ID, MIGRATION_KEY_FINGERPRINT_SHA256
  MIGRATION_SAS_FILE when using user-delegation-sas
USAGE
  exit 2
}

command_name=${1:-}
[[ "$command_name" == "issue-sas" || "$command_name" == "canary" ]] || usage

: "${MIGRATION_RUN_DIR:?MIGRATION_RUN_DIR is required}"
: "${MIGRATION_RUN_ID:?MIGRATION_RUN_ID is required}"
: "${MIGRATION_STORAGE_ACCOUNT:?MIGRATION_STORAGE_ACCOUNT is required}"

if [[ ! "$MIGRATION_RUN_ID" =~ ^[a-z0-9][a-z0-9-]{2,39}$ ]]; then
  echo "staging-migration-upload: invalid run ID" >&2
  exit 1
fi
if [[ ! "$MIGRATION_STORAGE_ACCOUNT" =~ ^brainstgmig[a-z0-9]{3,14}$ ]]; then
  echo "staging-migration-upload: storage account is not staging migration intake" >&2
  exit 1
fi
if [[ ! -d "$MIGRATION_RUN_DIR" ]]; then
  echo "staging-migration-upload: run directory does not exist" >&2
  exit 1
fi
run_mode=$(stat -c '%a' "$MIGRATION_RUN_DIR")
if [[ "$run_mode" != "700" ]]; then
  echo "staging-migration-upload: run directory must have mode 0700" >&2
  exit 1
fi

umask 077
container="intake-${MIGRATION_RUN_ID}"
blob_host="${MIGRATION_STORAGE_ACCOUNT}.blob.core.windows.net"
expected_azure_config="${MIGRATION_RUN_DIR}/azure-cli"
if [[ -n "${AZURE_CONFIG_DIR:-}" && "$AZURE_CONFIG_DIR" != "$expected_azure_config" ]]; then
  echo "staging-migration-upload: AZURE_CONFIG_DIR must be inside the protected run directory" >&2
  exit 1
fi
export AZURE_CONFIG_DIR="$expected_azure_config"
mkdir -p "$AZURE_CONFIG_DIR"
chmod 0700 "$AZURE_CONFIG_DIR"

resolved_ips=$(getent ahostsv4 "$blob_host" | awk '{print $1}' | sort -u)
if [[ -z "$resolved_ips" ]]; then
  echo "staging-migration-upload: Blob hostname did not resolve" >&2
  exit 1
fi
RESOLVED_IPS="$resolved_ips" node --input-type=module <<'NODE'
import { isIP } from "node:net";

const addresses = (process.env.RESOLVED_IPS ?? "").split(/\s+/).filter(Boolean);
const privateV4 = (address) => {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
if (addresses.length === 0 || addresses.some((address) => !privateV4(address))) {
  process.stderr.write("staging-migration-upload: Blob DNS did not resolve exclusively to private IPv4 addresses\n");
  process.exit(1);
}
NODE

if [[ "$command_name" == "canary" && "${MIGRATION_AUTH_MODE:-}" == "managed-identity" ]]; then
  managed_identity_args=(--identity)
  if [[ -n "${MIGRATION_MANAGED_IDENTITY_CLIENT_ID:-}" ]]; then
    if [[ ! "$MIGRATION_MANAGED_IDENTITY_CLIENT_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
      echo "staging-migration-upload: managed identity client ID must be a UUID" >&2
      exit 1
    fi
    managed_identity_args+=(--client-id "$MIGRATION_MANAGED_IDENTITY_CLIENT_ID")
  fi
  az login "${managed_identity_args[@]}" --output none
fi

account_json=$(az storage account show --name "$MIGRATION_STORAGE_ACCOUNT" --output json)
if [[ $(jq -r '.publicNetworkAccess' <<<"$account_json") != "Disabled" ]]; then
  echo "staging-migration-upload: public Blob network access is not disabled" >&2
  exit 1
fi
if [[ $(jq -r '.allowSharedKeyAccess' <<<"$account_json") != "false" ]]; then
  echo "staging-migration-upload: Shared Key access is not disabled" >&2
  exit 1
fi
if [[ $(jq -r '.enableHttpsTrafficOnly' <<<"$account_json") != "true" ]]; then
  echo "staging-migration-upload: HTTPS-only storage is not enabled" >&2
  exit 1
fi

if [[ "$command_name" == "issue-sas" ]]; then
  : "${MIGRATION_MEASURED_TRANSFER_SECONDS:?MIGRATION_MEASURED_TRANSFER_SECONDS is required}"
  if [[ ! "$MIGRATION_MEASURED_TRANSFER_SECONDS" =~ ^[0-9]+$ ]] || ((MIGRATION_MEASURED_TRANSFER_SECONDS < 1)); then
    echo "staging-migration-upload: measured transfer duration must be a positive number of seconds" >&2
    exit 1
  fi
  sas_file="${MIGRATION_RUN_DIR}/upload.sas"
  if [[ -e "$sas_file" ]]; then
    echo "staging-migration-upload: SAS file already exists" >&2
    exit 1
  fi
  expiry=$(MEASURED_SECONDS="$MIGRATION_MEASURED_TRANSFER_SECONDS" node --input-type=module <<'NODE'
const measured = Number(process.env.MEASURED_SECONDS);
const margin = Math.max(3600, Math.ceil(measured * 0.25));
const lifetime = measured + margin;
if (!Number.isSafeInteger(measured) || lifetime > 12 * 3600) {
  process.stderr.write("staging-migration-upload: measured duration plus safety margin exceeds the 12-hour SAS maximum\n");
  process.exit(1);
}
process.stdout.write(new Date(Date.now() + lifetime * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
NODE
  )
  az storage container generate-sas \
    --account-name "$MIGRATION_STORAGE_ACCOUNT" \
    --name "$container" \
    --as-user \
    --auth-mode login \
    --https-only \
    --permissions cw \
    --expiry "$expiry" \
    --output tsv >"$sas_file"
  chmod 0600 "$sas_file"
  printf '%s\n' "user-delegation SAS written to the mode-0600 run file"
  exit 0
fi

: "${MIGRATION_AUTH_MODE:?MIGRATION_AUTH_MODE is required}"
: "${MIGRATION_PUBLIC_KEY_FILE:?MIGRATION_PUBLIC_KEY_FILE is required}"
: "${MIGRATION_KEY_ID:?MIGRATION_KEY_ID is required}"
: "${MIGRATION_KEY_FINGERPRINT_SHA256:?MIGRATION_KEY_FINGERPRINT_SHA256 is required}"
if [[ "$MIGRATION_AUTH_MODE" != "managed-identity" && "$MIGRATION_AUTH_MODE" != "user-delegation-sas" ]]; then
  echo "staging-migration-upload: auth mode must be managed-identity or user-delegation-sas" >&2
  exit 1
fi
if [[ ! -f "$MIGRATION_PUBLIC_KEY_FILE" ]]; then
  echo "staging-migration-upload: approved public key file is missing" >&2
  exit 1
fi
if [[ ! "$MIGRATION_KEY_ID" =~ ^https://brain-staging-[a-z0-9-]+\.vault\.azure\.net/keys/migration-rehearsal-wrap/[A-Za-z0-9-]+$ ]]; then
  echo "staging-migration-upload: key ID is not a versioned staging migration key" >&2
  exit 1
fi
if [[ ! "$MIGRATION_KEY_FINGERPRINT_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "staging-migration-upload: approved key fingerprint must be lowercase SHA-256 hex" >&2
  exit 1
fi
actual_key_fingerprint=$(PUBLIC_KEY_FILE="$MIGRATION_PUBLIC_KEY_FILE" node --input-type=module <<'NODE'
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

const key = createPublicKey(readFileSync(process.env.PUBLIC_KEY_FILE));
if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072) {
  process.stderr.write("staging-migration-upload: public key is not RSA-3072\n");
  process.exit(1);
}
const der = key.export({ type: "spki", format: "der" });
process.stdout.write(createHash("sha256").update(der).digest("hex"));
NODE
)
if [[ "$actual_key_fingerprint" != "$MIGRATION_KEY_FINGERPRINT_SHA256" ]]; then
  echo "staging-migration-upload: public key fingerprint does not match the approved receipt" >&2
  exit 1
fi

canary_plaintext="${MIGRATION_RUN_DIR}/canary.plaintext"
canary_ciphertext="${MIGRATION_RUN_DIR}/canary.enc"
canary_envelope="${MIGRATION_RUN_DIR}/canary.envelope.json"
receipt_file="${MIGRATION_RUN_DIR}/canary-receipt.json"
for path in "$canary_plaintext" "$canary_ciphertext" "$canary_envelope" "$receipt_file"; do
  if [[ -e "$path" ]]; then
    echo "staging-migration-upload: refusing to overwrite $path" >&2
    exit 1
  fi
done

RUN_ID="$MIGRATION_RUN_ID" node --input-type=module -e \
  'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], Buffer.concat([Buffer.from(`brain-staging-canary:${process.env.RUN_ID}:`), randomBytes(32)]), { mode: 0o600, flag: "wx" });' \
  "$canary_plaintext"

node scripts/ops/staging-migration-envelope.mjs encrypt \
  --input "$canary_plaintext" \
  --output "$canary_ciphertext" \
  --envelope "$canary_envelope" \
  --public-key "$MIGRATION_PUBLIC_KEY_FILE" \
  --key-id "$MIGRATION_KEY_ID" \
  >"${MIGRATION_RUN_DIR}/encryption-receipt.json"

upload_args=(--account-name "$MIGRATION_STORAGE_ACCOUNT" --container-name "$container" --overwrite false --only-show-errors)
if [[ "$MIGRATION_AUTH_MODE" == "managed-identity" ]]; then
  upload_args+=(--auth-mode login)
else
  : "${MIGRATION_SAS_FILE:?MIGRATION_SAS_FILE is required for user-delegation-sas}"
  if [[ $(stat -c '%a' "$MIGRATION_SAS_FILE") != "600" ]]; then
    echo "staging-migration-upload: SAS file must have mode 0600" >&2
    exit 1
  fi
  export AZURE_STORAGE_SAS_TOKEN
  AZURE_STORAGE_SAS_TOKEN=$(<"$MIGRATION_SAS_FILE")
fi

az storage blob upload "${upload_args[@]}" --name canary/probe.enc --file "$canary_ciphertext" --output none
az storage blob upload "${upload_args[@]}" --name canary/probe.envelope.json --file "$canary_envelope" --output none

plaintext_sha256=$(shasum -a 256 "$canary_plaintext" | awk '{print $1}')
jq -n \
  --arg run_id "$MIGRATION_RUN_ID" \
  --arg container "$container" \
  --arg key_id "$MIGRATION_KEY_ID" \
  --arg plaintext_sha256 "$plaintext_sha256" \
  '{
    summary: "staging_migration_canary_uploaded",
    run_id: $run_id,
    container: $container,
    key_id: $key_id,
    plaintext_sha256: $plaintext_sha256,
    blobs: ["canary/probe.enc", "canary/probe.envelope.json"]
  }' >"$receipt_file"
chmod 0600 "$receipt_file"
rm -f "$canary_plaintext"
unset AZURE_STORAGE_SAS_TOKEN || true
printf '%s\n' "encrypted canary uploaded; receipt written to the mode-0600 run file"
