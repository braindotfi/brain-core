#!/usr/bin/env bash
# Dev-only seed script: wires the ledger so the on-chain rail can execute a
# real Base Sepolia transaction through the normal PaymentIntent flow.
#
# What it does:
#   1. Upserts an ETH onchain account (acct_01KSKZHH0WMD39V5AV4RP6MEFE) for the demo tenant.
#   2. Sets a 0x ETH address alias on Acme Holdings (cp_01KRXGMG09AB9SF2Z87YCF277N).
#   3. Prepends an onchain_tx auto-approve rule to the active tenant policy.
#
# Env:
#   DATABASE_URL      postgres://... (default: postgres://brain:brain@localhost:5432/brain)
#   ONCHAIN_RECIPIENT 0x<40-hex> — the ETH address the smart account will send to
#   BRAIN_TENANT_ID   (default: tnt_00000000010000000000000000)
#
# Run AFTER: golden-path seed, contract deployment (DeployOnchainDemo.s.sol).
# Run BEFORE: restarting brain-server with BRAIN_ONCHAIN_SMART_ACCOUNT set.
set -euo pipefail

DB_URL="${DATABASE_URL:-postgres://brain:brain@localhost:5432/brain}"
TENANT="${BRAIN_TENANT_ID:-tnt_00000000010000000000000000}"
RECIPIENT="${ONCHAIN_RECIPIENT:-}"

if [[ -z "$RECIPIENT" ]] || ! [[ "$RECIPIENT" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "ERROR: ONCHAIN_RECIPIENT must be a 0x-prefixed 40-hex-char Ethereum address." >&2
  echo "  Example: ONCHAIN_RECIPIENT=0x41D4ce9D9Fe968Ca1230bDc296B28fdc9AA6FF6E" >&2
  exit 1
fi

echo "Seeding on-chain demo data for tenant: $TENANT"
echo "  ONCHAIN_RECIPIENT = $RECIPIENT"

psql "$DB_URL" <<SQL
BEGIN;
SET LOCAL app.tenant_id = '$TENANT';

-- 1. Upsert ETH onchain account
INSERT INTO ledger_accounts (
  id, owner_id, institution, account_type, name, currency,
  current_balance, available_balance, status,
  source_ids, evidence_ids, provenance, confidence
) VALUES (
  'acct_01KSKZHH0WMD39V5AV4RP6MEFE',
  '$TENANT',
  'Base Sepolia',
  'onchain',
  'Brain Smart Account (Base Sepolia)',
  'ETH',
  10.0,
  10.0,
  'active',
  ARRAY[]::text[],
  ARRAY[]::text[],
  'human_confirmed',
  1.0
)
ON CONFLICT (id) DO UPDATE SET
  available_balance = EXCLUDED.available_balance,
  current_balance   = EXCLUDED.current_balance,
  updated_at        = now();

-- 2. Set 0x ETH alias on Acme Holdings counterparty
UPDATE ledger_counterparties
SET aliases = ARRAY['$RECIPIENT']
WHERE id = 'cp_01KRXGMG09AB9SF2Z87YCF277N';

-- 3. Prepend onchain_tx auto-approve rule to the active tenant policy
UPDATE policies
SET content = jsonb_set(
  content,
  '{rules}',
  '[{"id":"allow-onchain-tx-demo","when":{"amount.lte":{"value":"0.05","currency":"ETH"}},"execute":"auto","applies_to":["onchain_tx"]}]'::jsonb
  || (content->'rules')
)
WHERE tenant_id = '$TENANT' AND state = 'active';

COMMIT;
SQL

echo ""
echo "Verifying..."
psql "$DB_URL" --no-align --tuples-only <<SQL
SET app.tenant_id = '$TENANT';
SELECT 'account'       , id, currency, account_type FROM ledger_accounts WHERE id = 'acct_01KSKZHH0WMD39V5AV4RP6MEFE'
UNION ALL
SELECT 'counterparty'  , id, aliases[1], 'alias' FROM ledger_counterparties WHERE id = 'cp_01KRXGMG09AB9SF2Z87YCF277N'
UNION ALL
SELECT 'policy_rule'   , id, (content->'rules'->0->>'id'), state FROM policies WHERE tenant_id = '$TENANT' AND state = 'active';
SQL

echo ""
echo "Seed complete."
echo "Next: update .env with BRAIN_ONCHAIN_SMART_ACCOUNT=<address>, then restart brain-server."
