# Production environment — managed Azure stack.
#
# Usage:
#   terraform init -backend-config=backend-production.hcl
#   terraform plan  -var-file=production.tfvars -var="operator_ip=$(curl -s ifconfig.me)/32"
#
# operator_ip is NOT set here: it is the apply machine's public IP, it changes,
# and pinning it in a committed file makes stale-IP failures confusing. Pass it
# on the command line.

environment      = "production"
primary_location = "canadacentral"

services = ["api", "agents"]

# Human operator (sanket.debnath_redsoftware.in#EXT#@dreallayer.onmicrosoft.com)
# -- grants data-plane rights to set the operator-supplied secrets.
operator_object_id = "6ddc7121-6306-4061-9031-470410ad6a10"

# Observed operator egress: 152.58.44.154 (WSL) and 152.58.45.33 (Windows az)
# within minutes of each other -- same Jio CGNAT pool. /22 covers 152.58.44-47.
# Defence-in-depth only; RBAC is the real gate. Set to [] once CI writes secrets.
operator_extra_ip_ranges = ["152.58.44.0/22"]

# Right-sized production (chosen 2026-08-10). See variables.tf for the
# reasoning behind each default; these are the explicit production values.
postgres_sku_name        = "GP_Standard_D2s_v3"
postgres_storage_mb      = 131072
redis_sku_name           = "Balanced_B0"
acr_sku                  = "Basic"
storage_replication_type = "ZRS"
log_retention_days       = 90

api_min_replicas = 2
api_max_replicas = 6

# Off until the DNS cutover is scheduled.
enable_frontdoor = false

# ---------------------------------------------------------------------------
# Chain — Base Sepolia.
#
# Mainnet is gated on an external contract audit (ADR-0007) and the R-01 boot
# fence, which only fires at chainId 8453. Do not change these without clearing
# that gate.
#
# Addresses are the 2026-08-05 redeploy, byte-verified at block 45077782
# (BrainReputationRegistry at 45077887).
# ---------------------------------------------------------------------------
base_rpc_url = "https://sepolia.base.org"

onchain_addresses = {
  smart_account = "0x361978A2C737dB5Ae78746555760695ae5B49Aa2"

  audit_anchor        = "0xaB0EAc4Aef3318c94EaFe3027D6ee12ca21ae97A"
  policy_registry     = "0x2a81C10733CBe01d8dea7ED1212826CEa66477D9"
  agent_registry      = "0xC74c8B5930D1331B8e8A8b1AE438F999b545ECeB"
  reputation_registry = "0xEEA83c8a2f873176BE39a3Cd4dF3E704bF3584AD"
  escrow              = "0x8db324207f6d1B4846390D1000517D3725952F98"

  # Base Sepolia USDC, per SECURITY.md's contract table (x402 + escrow).
  usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
}

# 1 hour. Enforced by a validation rule — a shorter interval drains the
# publisher key.
# BRAIN_SESSION_KEY is injected. Required: EVERY rail except Plaid (which is
# not configured) is built from an onchainExecutor that only exists when this
# key is set, so with it absent the api boots to zero live rails and
# rails-prod-fence refuses to start.
#
# ⚠️ This is the SAME key the legacy VM uses, so both environments sign from one
# EOA and drive the same smart account. Harmless while this environment has no
# tenants and executes nothing; before both run live, this needs its own key
# authorised via grantSessionKey.
enable_onchain_signing = true

audit_anchor_interval_ms = 3600000

service_version = "0.0.7"
image_tag       = "latest"

# ---------------------------------------------------------------------------
# ⚠️ ANCHOR RACE WARNING — read before setting audit-publisher-key
#
# This stack points at the SAME BrainAuditAnchor as the live VM, and that
# contract accepts exactly one publisher address. If both the VM worker and this
# stack's worker run with the publisher key at the same time, they race to
# publish the same root: the loser reverts with RootAlreadyPublished and burns
# gas on every cycle — the failure recorded in `anchor-publisher-revert-fix`.
#
# The `audit-publisher-key` Key Vault secret is created as a PLACEHOLDER, which
# leaves the publisher inert. That is the safe default and it is intentional.
# Set the real key ONLY after the VM worker is stopped at cutover.
# ---------------------------------------------------------------------------
