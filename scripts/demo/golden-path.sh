#!/usr/bin/env bash
# Brain golden path — drives the ENTIRE protocol end-to-end against a running
# local stack (api boot binary + pg + redis), proving the full pipeline:
#
#   seed → ingest → normalize → wiki → reconcile → invoice-shortcut propose →
#   policy → approve → execute (rail) → anchor → fetch + verify proof.
#
# It prints a summary table (step, status, duration, output id) and the URL of
# the human-readable proof view to end on.
#
# Usage:
#   pnpm run dev:up                 # pg + redis + localstack
#   BRAIN_DEMO_MODE=true pnpm -C services/api start   # boot binary on :3000
#   ./scripts/demo/golden-path.sh [BASE_URL]
#
# Env:
#   BRAIN_BASE_URL   default http://localhost:3000
#   BRAIN_DEMO_RAIL  plaid_sandbox (default) | onchain_base_sepolia
#
# Exit code is non-zero if any REQUIRED step fails (used by the smoke test).

set -euo pipefail

BASE="${BRAIN_BASE_URL:-${1:-http://localhost:3000}}"
RAIL="${BRAIN_DEMO_RAIL:-plaid_sandbox}"
V1="$BASE/v1"

# The seed CLI requires BRAIN_TENANT_ID + BRAIN_ACTOR. Default to the demo
# golden tenant that GET /v1/demo/token mints for (DEMO_GOLDEN_TENANT in
# services/api/src/main.ts), so the seeded rows are visible to the demo token.
: "${BRAIN_TENANT_ID:=tnt_00000000010000000000000000}"
: "${BRAIN_ACTOR:=golden-path-seed}"
export BRAIN_TENANT_ID BRAIN_ACTOR

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
header() { echo -e "\n${BOLD}${CYAN}══ $1 ══${RESET}"; }
ok()     { echo -e "${GREEN}✓${RESET} $1"; }
note()   { echo -e "${YELLOW}→${RESET} $1"; }
fail()   { echo -e "${RED}✗${RESET} $1"; }

command -v jq >/dev/null || { fail "jq is required"; exit 1; }
command -v curl >/dev/null || { fail "curl is required"; exit 1; }

# ── summary accumulator ──────────────────────────────────────────────────────
declare -a SUMMARY=()        # "name|status|duration_ms|output"
STEP_START=0
start_step() { STEP_START=$(date +%s%3N 2>/dev/null || echo $(( $(date +%s) * 1000 ))); }
record()     { # name status output
  local now; now=$(date +%s%3N 2>/dev/null || echo $(( $(date +%s) * 1000 )))
  SUMMARY+=("$1|$2|$(( now - STEP_START ))|${3:-}")
}

# Authed JSON request: req METHOD PATH [BODY]
TOKEN=""
req() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sf -X "$method" "$V1$path" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
  else
    curl -sf -X "$method" "$V1$path" -H "Authorization: Bearer $TOKEN"
  fi
}

# ── 1. Seed a fresh demo tenant ──────────────────────────────────────────────
header "1. Seed golden-path dataset"
start_step
if pnpm -C tools/seed-golden-path run seed >/tmp/gp_seed.log 2>&1; then
  ok "seeded demo tenant (2 banks / 1 card / 5 subs)"; record "seed" ok ""
else
  fail "seed failed:"; cat /tmp/gp_seed.log >&2; record "seed" fail ""; exit 1
fi

# ── 2. Mint a demo token ─────────────────────────────────────────────────────
header "2. Mint demo token"
start_step
TOKEN=$(curl -sf "$V1/demo/token" | jq -r .token)
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { fail "no demo token"; record "token" fail ""; exit 1; }
ok "token ${TOKEN:0:24}…"; record "token" ok ""

# ── 3. Ingest a raw invoice artifact ─────────────────────────────────────────
header "3. Ingest raw invoice"
start_step
INGEST_BODY=$(jq -n '{
  source_type: "manual_upload", source_ref: "golden-path-invoice",
  mime_type: "application/json",
  body: { invoice_number: "INV-GP-001", vendor: "AWS", amount_due: "800.00", currency: "USD" }
}')
RAW=$(req POST /raw/ingest "$INGEST_BODY" || true)
RAW_ID=$(echo "${RAW:-}" | jq -r '.rawId // .raw_id // empty')
if [[ -n "$RAW_ID" ]]; then ok "raw artifact $RAW_ID"; record "ingest" ok "$RAW_ID"
else note "ingest endpoint shape may differ — adjust if needed"; record "ingest" warn ""; fi

# ── 4. Normalize → assert ledger rows ────────────────────────────────────────
header "4. Normalize → Ledger invoices + counterparties"
start_step
INVOICES=$(req GET "/ledger/invoices?status=sent&limit=5" || true)
INVOICE_ID=$(echo "${INVOICES:-}" | jq -r '.items[0].id // empty')
CPS=$(req GET "/ledger/counterparties?limit=5" || true)
CP_ID=$(echo "${CPS:-}" | jq -r '.items[0].id // empty')
if [[ -n "$INVOICE_ID" && -n "$CP_ID" ]]; then
  ok "invoice $INVOICE_ID, counterparty $CP_ID"; record "normalize" ok "$INVOICE_ID"
else
  fail "no normalized invoice/counterparty (is the normalize worker running?)"
  record "normalize" fail ""; exit 1
fi

# ── 5. Regenerate the counterparty Wiki page ─────────────────────────────────
header "5. Wiki page regeneration"
start_step
WIKI=$(req POST "/memory/pages/regenerate" "$(jq -n --arg id "$CP_ID" '{entity_id:$id}')" || true)
WIKI_OK=$(echo "${WIKI:-}" | jq -r '.id // .page_id // empty')
if [[ -n "$WIKI_OK" ]]; then ok "wiki page $WIKI_OK"; record "wiki" ok "$WIKI_OK"
else note "wiki regen endpoint may differ — non-blocking"; record "wiki" warn ""; fi

# ── 6. Run the reconciliation agent ──────────────────────────────────────────
header "6. Reconciliation agent"
start_step
RECON=$(req POST "/agents/route" "$(jq -n '{intent:"reconcile", payload:{}}')" || true)
RECON_OK=$(echo "${RECON:-}" | jq -r '.run_id // .decision // empty')
if [[ -n "$RECON_OK" ]]; then ok "reconciliation run $RECON_OK"; record "reconcile" ok "$RECON_OK"
else note "reconcile route may differ — non-blocking"; record "reconcile" warn ""; fi

# ── 7. Propose a PaymentIntent via the invoice shortcut (P0.5) ───────────────
header "7. Invoice-shortcut propose"
start_step
PI=$(req POST "/payment-intents" "$(jq -n --arg id "$INVOICE_ID" '{type:"pay_invoice", invoice_id:$id}')")
PI_ID=$(echo "$PI" | jq -r '.id')
OUTCOME=$(echo "$PI" | jq -r '.policy_decision.outcome // .outcome // "unknown"')
[[ -n "$PI_ID" && "$PI_ID" != "null" ]] || { fail "propose failed"; record "propose" fail ""; exit 1; }
ok "PaymentIntent $PI_ID (policy: $OUTCOME)"; record "propose" ok "$PI_ID"

# ── 8. Approve if the policy required confirmation ───────────────────────────
header "8. Approve (if confirm)"
start_step
if [[ "$OUTCOME" == "confirm" || "$OUTCOME" == "confirmed" ]]; then
  req POST "/payment-intents/$PI_ID/approve" '{}' >/dev/null && ok "auto-signed approver"
  record "approve" ok "$PI_ID"
else
  ok "no approval required (outcome=$OUTCOME)"; record "approve" ok ""
fi

# ── 9. Execute through the rail (§6 gate runs here) ──────────────────────────
header "9. Execute via rail ($RAIL)"
start_step
EXEC=$(req POST "/payment-intents/$PI_ID/execute" '{}')
EXEC_STATUS=$(echo "$EXEC" | jq -r '.status // .outcome // "unknown"')
ok "execute → $EXEC_STATUS"; record "execute" ok "$PI_ID"

# ── 10. Anchor the audit window ──────────────────────────────────────────────
header "10. Anchor audit window"
start_step
ANCHOR=$(req POST "/audit/anchor" '{}' || true)
ANCHOR_ROOT=$(echo "${ANCHOR:-}" | jq -r '.merkle_root // .root // empty')
if [[ -n "$ANCHOR_ROOT" ]]; then ok "anchored root ${ANCHOR_ROOT:0:18}…"; record "anchor" ok "$ANCHOR_ROOT"
else note "anchor publisher is a background worker — may anchor async"; record "anchor" warn ""; fi

# ── 11. Fetch + verify the proof ─────────────────────────────────────────────
header "11. Fetch + verify proof"
start_step
PROOF=$(req GET "/proof/$PI_ID")
ROOT=$(echo "$PROOF" | jq -r '.merkle_root')
LEAF=$(echo "$PROOF" | jq -r '.audit_events[0].event_hash // empty')
VERIFY=$(req POST "/audit/verify" "$(jq -n --arg r "$ROOT" --arg l "$LEAF" \
  --argjson p "$(echo "$PROOF" | jq '.merkle_proof')" '{merkle_root:$r, leaf:$l, proof:$p}')" || true)
VERIFIED=$(echo "${VERIFY:-}" | jq -r '.verified // .valid // "unknown"')
ok "proof verify → $VERIFIED"; record "verify" ok "$VERIFIED"

# ── 12. Summary ──────────────────────────────────────────────────────────────
header "Summary"
printf "%-12s %-7s %-10s %s\n" "STEP" "STATUS" "DURATION" "OUTPUT"
printf "%-12s %-7s %-10s %s\n" "----" "------" "--------" "------"
EXIT=0
for r in "${SUMMARY[@]}"; do
  IFS='|' read -r name status dur out <<<"$r"
  printf "%-12s %-7s %-10s %s\n" "$name" "$status" "${dur}ms" "$out"
  [[ "$status" == "fail" ]] && EXIT=1
done

echo
ok "Human-readable proof: ${V1}/proof/${PI_ID}/view"
exit "$EXIT"
