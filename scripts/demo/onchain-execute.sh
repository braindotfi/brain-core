#!/usr/bin/env bash
# On-chain PaymentIntent demo — drives a real Base Sepolia transaction through
# the full brain-core execute path:
#
#   propose (onchain_transfer) → policy auto-approve → §6 gate → outbox →
#   OnchainBaseRail → BrainSmartAccount.executeViaSessionKey → tx on-chain →
#   PaymentIntent.status=executed + receipt persisted
#
# Prerequisites (run these first):
#   1. forge script contracts/script/DeployOnchainDemo.s.sol --rpc-url ... --broadcast
#   2. Add BRAIN_ONCHAIN_SMART_ACCOUNT and BRAIN_ONCHAIN_POLICY_VERSION to .env
#   3. bash scripts/seed-onchain-demo.sh  (ONCHAIN_RECIPIENT=<deployer-eoa>)
#   4. brain-server running (pnpm -C services/api start)
#      — boot log should show "on-chain Base rail registered"
#
# Usage:
#   bash scripts/demo/onchain-execute.sh [BASE_URL]
#
# Env:
#   BRAIN_BASE_URL   default http://localhost:3000
set -euo pipefail

BASE="${BRAIN_BASE_URL:-${1:-http://localhost:3000}}"
V1="$BASE/v1"

command -v jq   >/dev/null || { echo "ERROR: jq is required"; exit 1; }
command -v curl >/dev/null || { echo "ERROR: curl is required"; exit 1; }

ok()   { echo "  [OK]  $*"; }
fail() { echo "  [FAIL] $*" >&2; }

# ── Step 1: demo token ────────────────────────────────────────────────────────
echo ""
echo "Step 1 — demo token"
TOKEN=$(curl -sf "$V1/demo/token" | jq -r '.token')
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { fail "no demo token from $V1/demo/token"; exit 1; }
ok "token ${TOKEN:0:24}…"

req() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sf -X "$method" "$V1$path" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
  else
    curl -sf -X "$method" "$V1$path" -H "Authorization: Bearer $TOKEN"
  fi
}

# ── Step 2: propose onchain_transfer ─────────────────────────────────────────
echo ""
echo "Step 2 — propose onchain_transfer (0.01 ETH → Acme Holdings)"
PI_BODY=$(jq -n '{
  action_type: "onchain_transfer",
  source_account_id: "acct_01KSKZHH0WMD39V5AV4RP6MEFE",
  destination_counterparty_id: "cp_01KRXGMG09AB9SF2Z87YCF277N",
  amount: "0.01",
  currency: "ETH"
}')

PI_RESP=$(curl -s -X POST "$V1/payment-intents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$PI_BODY")

PI_ID=$(echo "$PI_RESP"    | jq -r '.id // empty')
PI_STATUS=$(echo "$PI_RESP" | jq -r '.status // .error.code // "unknown"')
POLICY_OUTCOME=$(echo "$PI_RESP" | jq -r '.policy_decision.outcome // "n/a"')

if [[ -z "$PI_ID" ]]; then
  fail "propose failed: $(echo "$PI_RESP" | jq -c '.error // .')"
  exit 1
fi
ok "proposed $PI_ID  status=$PI_STATUS  policy=$POLICY_OUTCOME"

if [[ "$PI_STATUS" != "approved" ]]; then
  fail "Expected status=approved (auto policy), got: $PI_STATUS"
  echo "  Full response: $(echo "$PI_RESP" | jq -c .)" >&2
  echo "  Tip: run scripts/seed-onchain-demo.sh to add the onchain_tx policy rule." >&2
  exit 1
fi

# ── Step 3: execute ───────────────────────────────────────────────────────────
echo ""
echo "Step 3 — execute (triggers §6 gate + outbox + OnchainBaseRail)"
IDEM_KEY="onchain-demo-$(date +%s)"
EXEC_RESP=$(curl -s -X POST "$V1/payment-intents/$PI_ID/execute" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -d '{}')

EXEC_STATUS=$(echo "$EXEC_RESP" | jq -r '.status // .error.code // "unknown"')
if [[ "$EXEC_STATUS" == *"error"* ]] || echo "$EXEC_RESP" | jq -e '.error' >/dev/null 2>&1; then
  fail "execute failed: $(echo "$EXEC_RESP" | jq -c '.error // .')"
  exit 1
fi
ok "execute accepted  status=$EXEC_STATUS"

# ── Step 4: poll until settled ────────────────────────────────────────────────
echo ""
echo "Step 4 — polling for settlement (outbox → OnchainBaseRail → Base Sepolia)…"
TERMINAL_STATES="executed failed reconciling cancelled"
TIMEOUT=90
ELAPSED=0

while true; do
  POLL=$(req GET "/payment-intents/$PI_ID")
  POLL_STATUS=$(echo "$POLL" | jq -r '.status // "unknown"')

  if echo "$TERMINAL_STATES" | grep -qw "$POLL_STATUS"; then
    break
  fi

  if (( ELAPSED >= TIMEOUT )); then
    fail "Timed out after ${TIMEOUT}s waiting for terminal state (current: $POLL_STATUS)"
    exit 1
  fi

  printf "  … %ds  status=%s\n" "$ELAPSED" "$POLL_STATUS"
  sleep 3
  ELAPSED=$(( ELAPSED + 3 ))
done

ok "settled  status=$POLL_STATUS"

if [[ "$POLL_STATUS" != "executed" ]]; then
  fail "Expected executed, got: $POLL_STATUS"
  echo "  Check outbox worker logs for the error." >&2
  exit 1
fi

# ── Step 5: fetch receipt ─────────────────────────────────────────────────────
echo ""
echo "Step 5 — fetching execution receipt"
RECEIPT_IDS=$(echo "$POLL" | jq -r '.execution_receipt_ids[]? // empty' | head -1)
if [[ -z "$RECEIPT_IDS" ]]; then
  fail "No execution_receipt_ids on the PaymentIntent"
  exit 1
fi

RECEIPT=$(req GET "/execution-receipts/$RECEIPT_IDS" 2>/dev/null || echo '{}')
TX_HASH=$(echo "$RECEIPT"     | jq -r '.tx_hash // empty')
BLOCK=$(echo "$RECEIPT"       | jq -r '.block_number // empty')
GAS=$(echo "$RECEIPT"         | jq -r '.gas_used // empty')
RAIL_KIND=$(echo "$RECEIPT"   | jq -r '.rail // empty')

# Fall back to receipt embedded in PaymentIntent response if dedicated endpoint absent
if [[ -z "$TX_HASH" ]]; then
  TX_HASH=$(echo "$POLL" | jq -r '.receipts[0].tx_hash // .receipt.tx_hash // empty')
fi

echo ""
echo "============================================================"
echo " ON-CHAIN EXECUTION COMPLETE"
echo "============================================================"
echo " PaymentIntent : $PI_ID"
echo " Status        : $POLL_STATUS"
echo " Rail          : ${RAIL_KIND:-onchain}"
echo " Tx Hash       : ${TX_HASH:-<see outbox worker logs>}"
echo " Block         : ${BLOCK:-}"
echo " Gas Used      : ${GAS:-}"
echo ""
if [[ -n "$TX_HASH" && "$TX_HASH" != "null" ]]; then
  echo " View on chain : https://sepolia.basescan.org/tx/$TX_HASH"
fi
echo "============================================================"
