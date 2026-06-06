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
#   BRAIN_BASE_URL              default http://localhost:3000
#   BRAIN_DEMO_RAIL             plaid_sandbox (default) | onchain_base_sepolia
#   BRAIN_DEMO_STRICT_PROOF     "true" ⇒ steps 9/10/11 BLOCK until proof
#                               materializes + verifies. Used by investor
#                               diligence runs that must prove the full chain
#                               end-to-end, not just "we ran the propose."
#                               Default false (smoke runs stay fast).
#   BRAIN_DEMO_STRICT_TIMEOUT   seconds to wait for each blocking step in
#                               strict mode (default 90). Increase for slow
#                               testnet anchoring; decrease for tight CI.
#
# Exit code is non-zero if any REQUIRED step fails (used by the smoke test).
# In strict mode, steps 9 / 10 / 11 are ALL required (the whole pipeline must
# settle, anchor, and produce a verifiable Merkle proof) — not "fast" smoke.

set -euo pipefail

BASE="${BRAIN_BASE_URL:-${1:-http://localhost:3000}}"
RAIL="${BRAIN_DEMO_RAIL:-plaid_sandbox}"
STRICT="${BRAIN_DEMO_STRICT_PROOF:-false}"
STRICT_TIMEOUT="${BRAIN_DEMO_STRICT_TIMEOUT:-90}"
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

# poll_until <description> <body_cmd> <success_jq_expr>
#   Used only in BRAIN_DEMO_STRICT_PROOF=true mode. Re-runs `body_cmd` (a shell
#   snippet that fetches a JSON response and prints it on stdout) every 2s
#   until `success_jq_expr` returns a non-empty / non-null value, or until
#   STRICT_TIMEOUT seconds elapse. Echoes the matched value on success.
#   Returns 1 (the script will exit under set -e) on timeout.
poll_until() {
  local description="$1" body_cmd="$2" success_expr="$3"
  local deadline=$(( SECONDS + STRICT_TIMEOUT ))
  local resp matched
  while (( SECONDS < deadline )); do
    resp=$(eval "$body_cmd" || true)
    matched=$(echo "${resp:-}" | jq -r "$success_expr // empty" 2>/dev/null || true)
    if [[ -n "$matched" && "$matched" != "null" ]]; then
      echo "$matched"
      return 0
    fi
    sleep 2
  done
  fail "strict mode: $description did not materialize within ${STRICT_TIMEOUT}s"
  return 1
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
# GET /ledger/invoices returns { invoices: [...] }; /ledger/counterparties
# returns { counterparties: [...] } — not { items: [...] }.
INVOICES=$(req GET "/ledger/invoices?status=sent&limit=5" || true)
INVOICE_ID=$(echo "${INVOICES:-}" | jq -r '.invoices[0].id // empty')
CPS=$(req GET "/ledger/counterparties?limit=20" || true)
CP_ID=$(echo "${CPS:-}" | jq -r '.counterparties[0].id // empty')
# AWS counterparty id — needed by the onchain_base_sepolia branch in step 7.
AWS_CP_ID=$(echo "${CPS:-}" | jq -r '.counterparties[] | select(.name == "Amazon Web Services") | .id // empty' | head -1)
# Checking account id — source for ACH intents; onchain account for ETH intents.
ACCOUNTS=$(req GET "/ledger/accounts?limit=20" || true)
CHECKING_ACCOUNT_ID=$(echo "${ACCOUNTS:-}" | jq -r '.accounts[] | select(.account_type == "bank_checking") | .id // empty' | head -1)
ONCHAIN_ACCOUNT_ID=$(echo "${ACCOUNTS:-}" | jq -r '.accounts[] | select(.account_type == "onchain") | .id // empty' | head -1)
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

# ── 6.5 Activate the demo policy ─────────────────────────────────────────────
# The §6 gate evaluates the tenant's ACTIVE policy; a freshly-seeded tenant has
# none, so the propose below would fail `policy_not_found`. Activate the built-in
# demo policy first (the demo token carries policy:write). Required, not optional.
header "6.5 Activate demo policy"
start_step
if curl -sf -X POST "$V1/demo/policy/activate" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' >/dev/null; then
  ok "demo policy activated"
  record "policy" ok ""
else
  fail "policy activation failed (POST /demo/policy/activate)"
  record "policy" fail ""
  exit 1
fi

# ── 7. Propose a PaymentIntent ───────────────────────────────────────────────
# Default: invoice shortcut (pay_invoice → ach_outbound → bank_ach rail).
# onchain_base_sepolia: direct onchain_transfer intent to the AWS counterparty.
#   Requires BRAIN_DEMO_ONCHAIN_RECIPIENT to have been set at seed time so that
#   the AWS counterparty carries an ETH address alias. Requires the API to be
#   booted with BRAIN_SESSION_KEY + BRAIN_ONCHAIN_SMART_ACCOUNT configured.
header "7. Propose payment (rail: $RAIL)"
start_step
# Use curl -s (not -sf) so a 4xx error envelope is captured and shown, rather
# than failing the script under `set -e` with no diagnostic.
if [[ "$RAIL" == "onchain_base_sepolia" ]]; then
  [[ -n "$AWS_CP_ID" ]] || { fail "AWS counterparty not found — reseed with BRAIN_DEMO_ONCHAIN_RECIPIENT set"; record "propose" fail ""; exit 1; }
  [[ -n "$ONCHAIN_ACCOUNT_ID" ]] || { fail "onchain account not found — reseed with BRAIN_ONCHAIN_SMART_ACCOUNT set"; record "propose" fail ""; exit 1; }
  PI=$(curl -s -X POST "$V1/payment-intents" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -n --arg cp "$AWS_CP_ID" --arg src "$ONCHAIN_ACCOUNT_ID" '{
      action_type: "onchain_transfer",
      source_account_id: $src,
      destination_counterparty_id: $cp,
      amount: "0.0001",
      currency: "ETH"
    }')")
else
  PI=$(curl -s -X POST "$V1/payment-intents" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -n --arg id "$INVOICE_ID" '{type:"pay_invoice", invoice_id:$id}')")
fi
PI_ID=$(echo "$PI" | jq -r '.id // empty')
# The propose response carries the policy result as the intent `status`
# (approved | pending_approval | rejected — PaymentIntentService.create maps
# allow→approved, confirm→pending_approval, reject→rejected). Older field names
# (.policy_decision.outcome / .outcome) are kept as fallbacks but were never
# present, which is why this used to print "unknown".
OUTCOME=$(echo "$PI" | jq -r '.status // .policy_decision.outcome // .outcome // "unknown"')
[[ -n "$PI_ID" && "$PI_ID" != "null" ]] || { fail "propose failed: $PI"; record "propose" fail ""; exit 1; }
ok "PaymentIntent $PI_ID (policy: $OUTCOME)"; record "propose" ok "$PI_ID"

# ── 8. Approve if the policy required confirmation ───────────────────────────
header "8. Approve (if confirm)"
start_step
if [[ "$OUTCOME" == "confirm" || "$OUTCOME" == "confirmed" || "$OUTCOME" == "pending_approval" ]]; then
  req POST "/payment-intents/$PI_ID/approve" '{}' >/dev/null && ok "auto-signed approver"
  record "approve" ok "$PI_ID"
else
  ok "no approval required (status=$OUTCOME)"; record "approve" ok ""
fi

# ── 9. Execute through the rail (§6 gate runs here) ──────────────────────────
header "9. Execute via rail ($RAIL)"
start_step
# Use curl -s (not the -sf `req`) so a 4xx/5xx §6-gate rejection envelope is
# captured and its error.code surfaced, rather than aborting opaquely under
# `set -e` with only "exit code 22" (curl --fail). The gate runs here; its
# denials are the single most useful diagnostic this smoke test produces.
EXEC=$(curl -s -X POST "$V1/payment-intents/$PI_ID/execute" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}')
EXEC_ERR=$(echo "$EXEC" | jq -r '.error.code // empty')
if [[ -n "$EXEC_ERR" ]]; then
  fail "execute rejected: $EXEC_ERR — $(echo "$EXEC" | jq -r '.error.message // ""')"
  # Surface the gate's structured detail. For a §6 check-11.5 (duplicate)
  # rejection this carries { check_index, check_name, collisions:[{rule,
  # conflicting_payment_intent_id, detail}] } — the exact dedup rule that
  # fired, which is the difference between a seed/demo fix and a gate bug.
  echo "  detail: $(echo "$EXEC" | jq -c '.error.details // {}')" >&2
  record "execute" fail "$PI_ID"
  exit 1
fi
EXEC_STATUS=$(echo "$EXEC" | jq -r '.status // .outcome // "unknown"')
ok "execute → $EXEC_STATUS"; record "execute" ok "$PI_ID"

# Strict mode: the execute response status (202 + dispatching) doesn't prove
# the rail dispatched and the audit-after event landed. Poll the PI detail
# until it reaches a terminal state (executed / failed / cancelled). Anything
# else → diligence claim fails.
if [[ "$STRICT" == "true" ]]; then
  start_step
  if FINAL_STATUS=$(poll_until \
        "PaymentIntent terminal status" \
        "req GET /payment-intents/$PI_ID" \
        '.status | select(. == "executed" or . == "failed" or . == "cancelled")'); then
    if [[ "$FINAL_STATUS" == "executed" ]]; then
      ok "strict: PaymentIntent reached terminal status $FINAL_STATUS"
      record "execute_strict" ok "$FINAL_STATUS"
    else
      fail "strict: PaymentIntent ended in non-executed terminal status: $FINAL_STATUS"
      record "execute_strict" fail "$FINAL_STATUS"
      exit 1
    fi
  else
    record "execute_strict" fail "timeout"
    exit 1
  fi
fi

# ── 10. Anchor the audit window ──────────────────────────────────────────────
# The broadcaster worker publishes batches on an interval. Poll
# GET /audit/anchor/latest until a merkle_root appears.
header "10. Anchor audit window"
start_step
ANCHOR=$(req GET "/audit/anchor/latest" || true)
ANCHOR_ROOT=$(echo "${ANCHOR:-}" | jq -r '.merkle_root // empty')
if [[ -n "$ANCHOR_ROOT" ]]; then ok "anchored root ${ANCHOR_ROOT:0:18}…"; record "anchor" ok "$ANCHOR_ROOT"
elif [[ "$STRICT" == "true" ]]; then
  start_step
  if ANCHOR_ROOT=$(poll_until \
        "audit anchor merkle root" \
        "req GET /audit/anchor/latest" \
        '.merkle_root // empty'); then
    ok "strict: anchored root ${ANCHOR_ROOT:0:18}…"
    record "anchor_strict" ok "$ANCHOR_ROOT"
  else
    record "anchor_strict" fail "timeout"
    exit 1
  fi
else
  note "anchor publisher is a background worker — may anchor async"
  record "anchor" warn ""
fi

# ── 11. Fetch + verify the proof ─────────────────────────────────────────────
# Default behavior is non-blocking: the PI settles through the rail
# asynchronously (→ dispatching) and the audit anchor publisher is a background
# worker (step 10), so in a fast smoke the proof may not be materialized yet.
# Verify it when present; otherwise note it and move on so the smoke is fast.
#
# Strict mode (BRAIN_DEMO_STRICT_PROOF=true) blocks: it polls the Proof API
# until merkle_root is non-empty (or STRICT_TIMEOUT elapses), then REQUIRES
# verification to succeed. Used by investor-diligence runs where the whole
# point is to prove the full chain end-to-end, not just "we ran the propose."
header "11. Fetch + verify proof"
start_step
PROOF=""
ROOT=""
if [[ "$STRICT" == "true" ]]; then
  if PROOF_BODY=$(poll_until \
        "proof materialization for $PI_ID" \
        "req GET /proof/$PI_ID" \
        '.merkle_root // empty'); then
    PROOF=$(req GET "/proof/$PI_ID" || true)
    ROOT="$PROOF_BODY"
  else
    record "verify" fail "timeout"
    exit 1
  fi
else
  PROOF=$(req GET "/proof/$PI_ID" || true)
  ROOT=$(echo "${PROOF:-}" | jq -r '.merkle_root // empty')
fi

if [[ -n "$ROOT" ]]; then
  EVENT_HASH=$(echo "$PROOF" | jq -r '.audit_events[0].event_hash // empty')
  VERIFY=$(req POST "/audit/verify" "$(jq -n --arg r "$ROOT" --arg h "$EVENT_HASH" \
    --argjson p "$(echo "$PROOF" | jq '.merkle_proof')" '{merkle_root:$r, event_hash:$h, merkle_proof:$p}')" || true)
  VERIFIED=$(echo "${VERIFY:-}" | jq -r '.valid // .verified // "unknown"')
  if [[ "$STRICT" == "true" && "$VERIFIED" != "true" ]]; then
    fail "strict: proof verification did not succeed (verified=$VERIFIED)"
    record "verify" fail "$VERIFIED"
    exit 1
  fi
  ok "proof verify → $VERIFIED"; record "verify" ok "$VERIFIED"
else
  note "proof not materialized yet (PI dispatching / anchor async) — non-blocking"
  record "verify" warn ""
fi

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
