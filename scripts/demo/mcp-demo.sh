#!/usr/bin/env bash
# Brain MCP demo — drives a full payment proposal flow through the
# JSON-RPC 2.0 MCP surface at POST /v1/agents/mcp.
#
# Usage: ./scripts/demo/mcp-demo.sh [BASE_URL]
# Default BASE_URL: http://localhost:3000

set -euo pipefail

BASE="${1:-http://localhost:3000}"
MCP="$BASE/v1/agents/mcp"

# ── colours ────────────────────────────────────────────────────────────────
BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
RED='\033[0;31m'; RESET='\033[0m'

header() { echo -e "\n${BOLD}${CYAN}══ $1 ══${RESET}"; }
ok()     { echo -e "${GREEN}✓${RESET} $1"; }
note()   { echo -e "${YELLOW}→${RESET} $1"; }

# ── 1. Mint demo token ──────────────────────────────────────────────────────
header "1. Mint demo token"
TOKEN=$(curl -sf "$BASE/v1/demo/token" | jq -r .token)
ok "Token: ${TOKEN:0:30}…"

# Helper: POST a JSON-RPC 2.0 request to the MCP endpoint
mcp() {
  local method="$1" params="$2" id="$3"
  curl -sf -X POST "$MCP" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"$method\",\"params\":$params}"
}

# ── 2. List available tools ─────────────────────────────────────────────────
header "2. tools/list — discover MCP surface"
TOOLS=$(mcp "tools/list" "{}" 1)
echo "$TOOLS" | jq -r '.result.tools[] | "  • \(.name)"'
TOOL_COUNT=$(echo "$TOOLS" | jq '.result.tools | length')
ok "$TOOL_COUNT tools registered"

# ── 3. Read Ledger via MCP ──────────────────────────────────────────────────
header "3. ledger.accounts.list — read financial truth through MCP"
ACCOUNTS=$(mcp "tools/call" '{"name":"ledger.accounts.list","arguments":{"limit":5}}' 2)
echo "$ACCOUNTS" | jq -r '.result.content[0].text'

header "4. ledger.obligations.list — upcoming bills"
OBLIGATIONS=$(mcp "tools/call" '{"name":"ledger.obligations.list","arguments":{"status":"upcoming","limit":5}}' 3)
echo "$OBLIGATIONS" | jq -r '.result.content[0].text'

# ── 4. Propose a small payment (auto-approved by policy) ───────────────────
header "5. payment_intent.propose — \$800 ACH (policy: auto-approve ≤ \$1000)"
PROPOSE_SMALL=$(mcp "tools/call" '{
  "name": "payment_intent.propose",
  "arguments": {
    "action_type":                  "ach_outbound",
    "source_account_id":            "acct_01KRXGMG4NVBJ0A1BZ5PWH7PFP",
    "destination_counterparty_id":  "cp_01KRXGMG45Y3F9AAR2TPYAHZ39",
    "amount":                       "800.00",
    "currency":                     "USD"
  }
}' 4)
PI_SMALL_ID=$(echo "$PROPOSE_SMALL" | jq -r '.result.content[0].text' | grep -oP 'pi_[0-9A-Z]+' | head -1)
PI_SMALL_STATUS=$(echo "$PROPOSE_SMALL" | jq -r '.result.content[0].text' | grep -oP 'status \*\*\K[a-z_]+' | head -1)
echo "$PROPOSE_SMALL" | jq -r '.result.content[0].text'
ok "Intent $PI_SMALL_ID → status: $PI_SMALL_STATUS"

# ── 5. Propose a mid payment (pending_approval by policy) ──────────────────
header "6. payment_intent.propose — \$5000 ACH (policy: confirm / pending_approval)"
PROPOSE_MID=$(mcp "tools/call" '{
  "name": "payment_intent.propose",
  "arguments": {
    "action_type":                  "ach_outbound",
    "source_account_id":            "acct_01KRXGMG4NVBJ0A1BZ5PWH7PFP",
    "destination_counterparty_id":  "cp_01KRXGMG45Y3F9AAR2TPYAHZ39",
    "amount":                       "5000.00",
    "currency":                     "USD"
  }
}' 5)
PI_MID_ID=$(echo "$PROPOSE_MID" | jq -r '.result.content[0].text' | grep -oP 'pi_[0-9A-Z]+' | head -1)
PI_MID_STATUS=$(echo "$PROPOSE_MID" | jq -r '.result.content[0].text' | grep -oP 'status \*\*\K[a-z_]+' | head -1)
echo "$PROPOSE_MID" | jq -r '.result.content[0].text'
ok "Intent $PI_MID_ID → status: $PI_MID_STATUS"

# ── 6. Propose a large payment (rejected by policy) ────────────────────────
header "7. payment_intent.propose — \$15000 ACH (policy: reject > \$10000)"
PROPOSE_LARGE=$(mcp "tools/call" '{
  "name": "payment_intent.propose",
  "arguments": {
    "action_type":                  "ach_outbound",
    "source_account_id":            "acct_01KRXGMG4NVBJ0A1BZ5PWH7PFP",
    "destination_counterparty_id":  "cp_01KRXGMG45Y3F9AAR2TPYAHZ39",
    "amount":                       "15000.00",
    "currency":                     "USD"
  }
}' 6)
PI_LARGE_ID=$(echo "$PROPOSE_LARGE" | jq -r '.result.content[0].text' | grep -oP 'pi_[0-9A-Z]+' | head -1)
PI_LARGE_STATUS=$(echo "$PROPOSE_LARGE" | jq -r '.result.content[0].text' | grep -oP 'status \*\*\K[a-z_]+' | head -1)
echo "$PROPOSE_LARGE" | jq -r '.result.content[0].text'
ok "Intent $PI_LARGE_ID → status: $PI_LARGE_STATUS"

# ── 7. Summary ──────────────────────────────────────────────────────────────
header "Summary"
echo -e "  ${GREEN}$PI_SMALL_ID${RESET}  \$800   → ${GREEN}$PI_SMALL_STATUS${RESET}   (policy: auto)"
echo -e "  ${YELLOW}$PI_MID_ID${RESET}  \$5000  → ${YELLOW}$PI_MID_STATUS${RESET}  (policy: confirm)"
echo -e "  ${RED}$PI_LARGE_ID${RESET}  \$15000 → ${RED}$PI_LARGE_STATUS${RESET}      (policy: reject)"
echo ""
note "All three proposals went through MCP JSON-RPC → policy VM → Ledger."
note "None executed: MCP has no payment_intent.execute tool by design."
note "Execution only happens through the §6 gate on POST /payment-intents/{id}/execute."
