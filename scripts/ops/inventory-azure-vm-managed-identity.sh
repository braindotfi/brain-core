#!/usr/bin/env bash
set -euo pipefail

# Read-only Task 1 helper. It proves the VM identity before the staging
# migration stack grants either direct Blob access or SAS-issuer access.

: "${EXPECTED_VM_RESOURCE_ID:?EXPECTED_VM_RESOURCE_ID is required}"
: "${EVIDENCE_FILE:?EVIDENCE_FILE is required}"

if [[ "$EXPECTED_VM_RESOURCE_ID" != /subscriptions/*/resourceGroups/*/providers/Microsoft.Compute/virtualMachines/* ]]; then
  echo "inventory-azure-vm-managed-identity: EXPECTED_VM_RESOURCE_ID is not an Azure VM resource ID" >&2
  exit 1
fi
if [[ -e "$EVIDENCE_FILE" ]]; then
  echo "inventory-azure-vm-managed-identity: evidence file already exists" >&2
  exit 1
fi

umask 077
metadata_file=$(mktemp)
identity_file=$(mktemp)
cleanup() {
  rm -f "$metadata_file" "$identity_file"
}
trap cleanup EXIT

curl --fail --silent --show-error --max-time 10 \
  --header Metadata:true \
  'http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01' \
  >"$metadata_file"

actual_resource_id=$(jq -er '.resourceId' "$metadata_file")
if [[ "${actual_resource_id,,}" != "${EXPECTED_VM_RESOURCE_ID,,}" ]]; then
  echo "inventory-azure-vm-managed-identity: VM resource ID does not match the approved target" >&2
  exit 1
fi

# This ARM read reports principal IDs without requesting a managed-identity
# token or testing a data write. A discovered identity remains a candidate
# until the encrypted canary proves its scoped Blob authorization.
az vm identity show --ids "$EXPECTED_VM_RESOURCE_ID" --output json >"$identity_file"

jq -n \
  --arg resource_id "$actual_resource_id" \
  --arg vm_id "$(jq -er '.vmId' "$metadata_file")" \
  --slurpfile identity "$identity_file" \
  '{
    summary: "azure_vm_managed_identity_inventory",
    read_only: true,
    resource_id: $resource_id,
    vm_id: $vm_id,
    identity_type: ($identity[0].type // "None"),
    system_assigned_principal_id: ($identity[0].principalId // null),
    user_assigned_identities: (
      ($identity[0].userAssignedIdentities // {})
      | to_entries
      | map({resource_id: .key, client_id: .value.clientId, principal_id: .value.principalId})
    ),
    assessment: (
      if (($identity[0].principalId // "") != "") or ((($identity[0].userAssignedIdentities // {}) | length) > 0)
      then "candidate-found-canary-still-required"
      else "no-managed-identity-use-user-delegation-sas"
      end
    )
  }' >"$EVIDENCE_FILE"

chmod 0600 "$EVIDENCE_FILE"
printf '%s\n' "managed-identity inventory written to the approved evidence file"
