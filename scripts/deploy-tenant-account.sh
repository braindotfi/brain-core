#!/usr/bin/env bash
# Deploy a BrainSmartAccount for a single tenant on Base Sepolia.
#
# Required env:
#   TENANT_ID               - Brain tenant id string (e.g. "tnt_01ARZ...")
#   TENANT_OWNER            - EVM address that will own the account (hex)
#   BASE_SEPOLIA_RPC_URL    - Alchemy or public Base Sepolia RPC endpoint
#   DEPLOYER_PRIVATE_KEY    - Private key (0x-prefixed) used to broadcast
#
# Optional env:
#   POLICY_REGISTRY_ADDRESS - defaults to the deployed singleton on Base Sepolia

set -euo pipefail

POLICY_REGISTRY_ADDRESS="${POLICY_REGISTRY_ADDRESS:-0x683893CcD84D9A3487095D09feD324b6B8Ea2501}"

: "${TENANT_ID:?TENANT_ID is required}"
: "${TENANT_OWNER:?TENANT_OWNER is required}"
: "${BASE_SEPOLIA_RPC_URL:?BASE_SEPOLIA_RPC_URL is required}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is required}"

# Convert tenant_id string to padded bytes32 hex using cast.
TENANT_ID_BYTES32=$(cast to-bytes32 "$(cast --from-utf8 "$TENANT_ID")")

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)/contracts"

OUTPUT=$(cd "$SCRIPT_DIR" && forge script "script/DeployTenantAccount.s.sol" \
  --sig "run(address,bytes32,address)" \
  "$TENANT_OWNER" "$TENANT_ID_BYTES32" "$POLICY_REGISTRY_ADDRESS" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --json 2>&1)

# Extract the deployed contract address from the forge --json broadcast output.
# forge emits one JSON object per tx; contract_address is the deployed address.
ACCOUNT_ADDRESS=$(echo "$OUTPUT" | grep -o '"contract_address":"0x[a-fA-F0-9]*"' | head -1 | grep -o '0x[a-fA-F0-9]*')

jq -n \
  --arg tenant_id "$TENANT_ID" \
  --arg owner "$TENANT_OWNER" \
  --arg smart_account_address "$ACCOUNT_ADDRESS" \
  --arg policy_registry "$POLICY_REGISTRY_ADDRESS" \
  '{tenant_id: $tenant_id, owner: $owner, smart_account_address: $smart_account_address, policy_registry: $policy_registry}'
