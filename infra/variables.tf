variable "environment" {
  description = "Deployment environment: staging or production."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be one of: staging, production."
  }
}

variable "primary_location" {
  description = "Primary Azure region."
  type        = string
  default     = "canadacentral"
}

variable "services" {
  description = <<-EOT
    Externally-deployed Container Apps. Brain runs as a single boot binary, so
    the layer names (raw, wiki, policy, execution, audit) are NOT separate
    deployables -- they are lanes inside the api/worker process selected by
    BRAIN_WORKERS. Only `api` and `agents` are real images.

    The `worker` app is not listed here: it is a dedicated resource (see
    main.tf) because it runs the same image as `api` with HTTP disabled.
  EOT
  type        = set(string)
  default     = ["api", "agents"]

  validation {
    condition     = alltrue([for s in var.services : contains(["api", "agents"], s)])
    error_message = "services may only contain: api, agents. Layer names are not deployables."
  }
}

variable "openai_api_key_secret_name" {
  description = "Azure Key Vault secret name for the OpenAI API key used by the agents service."
  type        = string
  default     = "openai-api-key"
}

variable "brain_agents_inbound_secret_name" {
  description = "Azure Key Vault secret name for the API to agents HMAC secret."
  type        = string
  default     = "brain-agents-inbound-secret"
}

variable "brain_api_token_secret_name" {
  description = "Azure Key Vault secret name for the agents service outbound Brain API token."
  type        = string
  default     = "brain-api-token"
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

variable "vnet_address_space" {
  description = "VNet CIDR. Subnets are carved from this deterministically in network.tf."
  type        = string
  default     = "10.20.0.0/16"
}

variable "operator_ip" {
  description = <<-EOT
    Public IP (CIDR) of the machine running apply, added as a Key Vault
    network exception.

    Optional, and normally left unset. It only matters when
    key_vault_network_default_action is "Deny"; with the vault open it is
    inert. CI has no stable egress address, so the pipeline never sets it.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.operator_ip == null || can(cidrhost(var.operator_ip, 0))
    error_message = "operator_ip must be a CIDR, e.g. 203.0.113.4/32, or null."
  }
}

# ---------------------------------------------------------------------------
# Sizing -- explicit knobs instead of an is_prod ternary. Defaults are the
# "right-sized production" tier chosen 2026-08-10 (~$250-350/mo), not the
# original scaffold defaults (~$1.0-1.3k/mo).
# ---------------------------------------------------------------------------

variable "postgres_sku_name" {
  description = "Postgres Flexible Server SKU."
  type        = string
  default     = "GP_Standard_D2s_v3"
}

variable "postgres_storage_mb" {
  description = "Postgres storage in MB. Azure allows growth but never shrink."
  type        = number
  default     = 131072 # 128 GB
}

variable "postgres_backup_retention_days" {
  description = "Postgres automated backup retention (7-35)."
  type        = number
  default     = 14
}

variable "redis_sku_name" {
  description = <<-EOT
    Azure Managed Redis SKU. Balanced_B0 is the entry tier (~0.5GB) and is
    sufficient for queues + idempotency keys at current volume.

    NOTE: Azure Cache for Redis (Basic/Standard/Premium C/P SKUs) is retired
    for new creates -- those SKU names are no longer valid anywhere here.
  EOT
  type        = string
  default     = "Balanced_B0"
}

variable "acr_sku" {
  description = <<-EOT
    Container Registry SKU. Basic is sufficient: pulls authenticate via managed
    identity (AcrPull), and the registry holds no secrets. Premium is only
    required for private endpoints or geo-replication.
  EOT
  type        = string
  default     = "Basic"
}

variable "storage_replication_type" {
  description = <<-EOT
    Raw-layer blob replication. ZRS (zone-redundant) is the default: the Raw
    layer is the protocol's immutable source of truth, so LRS (single zone) is
    an unreasonable risk, while GRS roughly doubles cost for cross-region DR we
    do not yet operate.
  EOT
  type        = string
  default     = "ZRS"
}

variable "raw_immutability_days" {
  description = "Immutable retention on raw-artifacts. 7 years for production."
  type        = number
  default     = 2555
}

variable "log_retention_days" {
  description = "Log Analytics retention in days."
  type        = number
  default     = 90
}

variable "api_min_replicas" {
  description = "Minimum API replicas. 2 keeps a warm instance during revision swaps."
  type        = number
  default     = 2
}

variable "api_max_replicas" {
  description = "Maximum API replicas."
  type        = number
  default     = 6
}

variable "container_cpu" {
  description = "vCPU per container. Container Apps requires cpu/memory in fixed pairs (0.5/1.0Gi, 1.0/2.0Gi, ...)."
  type        = number
  default     = 1.0
}

variable "container_memory" {
  description = "Memory per container, paired with container_cpu."
  type        = string
  default     = "2.0Gi"
}

# ---------------------------------------------------------------------------
# Front Door -- off until DNS is cut over
# ---------------------------------------------------------------------------

variable "key_vault_network_default_action" {
  description = <<-EOT
    Key Vault network ACL default action: "Allow" or "Deny".

    "Deny" is only workable because the vault has a PRIVATE ENDPOINT and
    Terraform runs INSIDE the VNet, as the brain-production-terraform Container
    App Job. Terraform reads every azurerm_key_vault_secret during refresh, so
    running it from a public runner against a closed vault fails part-way
    through an apply.

    RECOVERY: if the in-VNet runner is broken and you are locked out, reopen the
    vault from the CONTROL plane, which is not IP-restricted:
      az keyvault update -n brain-production-kv -g brain-production-rg \
        --default-action Allow
    then set this back to "Deny" once the runner works again.
  EOT
  type        = string
  default     = "Deny"

  validation {
    condition     = contains(["Allow", "Deny"], var.key_vault_network_default_action)
    error_message = "must be Allow or Deny."
  }
}

variable "operator_extra_ip_ranges" {
  description = <<-EOT
    Additional CIDRs allowed through the Key Vault firewall, on top of the
    auto-detected operator_ip.

    Needed because this operator is behind carrier-grade NAT: WSL and Windows
    egress from DIFFERENT addresses in the same pool at the same moment, so a
    single detected /32 is never sufficient and rotates within the hour.

    This is defence-in-depth ONLY -- Entra RBAC is the actual control on secret
    access, and nothing here grants any permission by itself. Narrow it to []
    once CI owns secret writes and no human needs data-plane access.
  EOT
  type        = list(string)
  default     = []
}

variable "terraform_client_id" {
  description = <<-EOT
    Application (client) id the in-VNet Terraform runner authenticates as.

    This is the brain-terraform service principal, NOT the runner's managed
    identity. Managed identity does not work here: the azurerm STATE BACKEND's
    authorizer requests tokens at api-version 2018-02-01, and the Container Apps
    identity endpoint only speaks 2019-08-01. ARM_MSI_API_VERSION fixes the
    provider but the backend ignores it, so `terraform init` fails before
    anything else runs.
  EOT
  type        = string
  default     = "110019c2-6fef-4e1e-8f9d-67c9da234640"
}

variable "tfstate_storage_account_id" {
  description = <<-EOT
    Resource id of the remote-state storage account, so the in-VNet Terraform
    runner can be granted Storage Blob Data Contributor on it.

    Hard-coded rather than discovered: the state account lives in a different
    resource group created by infra/bootstrap, and a data source for it would
    make this stack depend on reading a resource it does not own.
  EOT
  type        = string
  default     = "/subscriptions/861547ad-b8ea-4f52-a51e-0638a4d4d446/resourceGroups/brain-tfstate-rg/providers/Microsoft.Storage/storageAccounts/brainfitfstate"
}

variable "operator_object_id" {
  description = <<-EOT
    Entra object id of the human operator who sets the operator-supplied
    secrets (auth-sign-key, email-*, the EVM keys).

    Needed because the vault uses RBAC authorization: subscription Contributor
    and even User Access Administrator are CONTROL-plane roles and grant no
    ability to read or write a secret's value. Without this the operator can
    create the vault but not put anything in it.

    Null skips the assignment (e.g. once CI owns all secret writes).
  EOT
  type        = string
  default     = null
}

variable "auth_issuer" {
  description = <<-EOT
    OAuth issuer claim. MUST be identical on the auth service (which mints
    tokens) and on api/worker (which verify them) -- a mismatch fails every
    token with an opaque error. Kept at the final hostname so the DNS cutover
    does not invalidate previously issued tokens.
  EOT
  type        = string
  default     = "https://auth.brain.fi"
}

variable "enable_onchain_signing" {
  description = <<-EOT
    Inject BRAIN_SESSION_KEY into api/worker.

    Default false. The Key Vault secret starts as a placeholder, and the config
    schema validates it as /^0x[0-9a-fA-F]{64}$/ -- injecting the placeholder
    does not merely disable signing, it CRASHES the process at boot. Flip this
    on only once a real key is in the vault.
  EOT
  type        = bool
  default     = false
}

variable "enable_anchor_publisher" {
  description = <<-EOT
    Inject AUDIT_PUBLISHER_KEY into the worker.

    Default false, and it must STAY false while the legacy VM is still
    anchoring: that contract accepts a single publisher, so two live workers
    race and the loser burns gas reverting RootAlreadyPublished every cycle.
    Same placeholder-fails-regex crash applies as above.
  EOT
  type        = bool
  default     = false
}

variable "enable_frontdoor" {
  description = <<-EOT
    Provision Front Door (profile + endpoint + origin + route).

    Default false, but production turns it on: it is the only thing in this
    environment that can serve mcp.brain.fi. That hostname needs `/` rewritten to
    `/v1/agents/mcp` and Container Apps ingress cannot rewrite paths. ~$35/mo.

    api.brain.fi and auth.brain.fi do not go through it -- they CNAME straight at
    their Container Apps, which already terminate HTTPS with managed certs.
  EOT
  type        = bool
  default     = false
}

variable "frontdoor_sku_name" {
  description = "Front Door SKU. Premium adds WAF + private origins; Standard is sufficient without them."
  type        = string
  default     = "Standard_AzureFrontDoor"
}

variable "frontdoor_mcp_custom_domain" {
  description = <<-EOT
    Hostname to bind to the Front Door mcp route. Empty (default) means no custom
    domain: the *.azurefd.net endpoint serves the rewrite and is fully testable.

    Set to "mcp.brain.fi" ~24h before the DNS cutover, apply, publish the
    _dnsauth.mcp TXT record from the frontdoor_mcp_domain_validation_token output,
    and wait for the managed certificate. Front Door validates from the TXT alone,
    so this happens while the A record still points at the VM. Only then move DNS.
  EOT
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Application configuration
# ---------------------------------------------------------------------------

variable "service_version" {
  description = "SERVICE_VERSION reported by /health. Must match the deployed image tag."
  type        = string
  default     = "0.0.7"
}

variable "image_tag" {
  description = "Image tag pulled from ACR for api/agents/worker."
  type        = string
  default     = "latest"
}

variable "terraform_image_tag" {
  description = <<-EOT
    Tag for the in-VNet runner image (brain-terraform), which carries the baked
    Terraform config. Empty (default) means "same as image_tag" -- correct for a
    normal deploy where everything is built at one SHA.

    Set it for an infra-only change, so the runner picks up the new config
    without repointing api/agents at images that were never built.
  EOT
  type        = string
  default     = ""
}

variable "audit_anchor_from_block" {
  description = "First block the anchor scanner reads. Set to the contracts' deployment block so it does not walk chain history from zero."
  type        = number
  default     = 45077782
}

variable "onchain_policy_version" {
  description = "On-chain policy version word checked by the gate."
  type        = string
  default     = "0x0000000000000000000000000000000000000000000000000000000000000001"
}

variable "onchain_min_max_fee_gwei" {
  description = <<-EOT
    Floor for maxFeePerGas. Lowered from 1.5 to these values on 2026-08-07 for
    roughly a 27x cost saving on anchoring; do not raise them back without a
    reason, and do not set them so low that transactions stop being mined.
  EOT
  type        = string
  default     = "0.20"
}

variable "onchain_min_priority_fee_gwei" {
  description = "Floor for maxPriorityFeePerGas. Set above observed Base rewards while avoiding the prior normal-operation overpayment. See onchain_min_max_fee_gwei."
  type        = string
  default     = "0.025"
}

variable "enable_service_token" {
  description = "Enable POST /v1/auth/service-token. Consumers (BrainMVB) depend on it; the secret is generated into Key Vault either way."
  type        = bool
  default     = true
}

variable "enable_demo_provision" {
  description = <<-EOT
    Enable the demo provisioning route.

    Default FALSE, deliberately diverging from the VM (which has it on for the
    BrainSaaS playground). It is a demo affordance that mints tenants on a
    public endpoint; a production environment should opt in explicitly rather
    than inherit it. Turning it on also arms a boot fence requiring
    BRAIN_DEMO_PROVISION_SECRET and, in production, TESTNET_ATTESTED.
  EOT
  type        = bool
  default     = false
}

variable "audit_anchor_interval_ms" {
  description = <<-EOT
    Anchor publisher interval. MUST stay at 3600000 (1h).

    A short interval drains the publisher key: at the previous 5s setting the
    key burned ETH continuously. See vault note `anchor-interval-eth-drain`.
  EOT
  type        = number
  default     = 3600000

  validation {
    condition     = var.audit_anchor_interval_ms >= 3600000
    error_message = "audit_anchor_interval_ms must be >= 3600000 (1h) -- shorter intervals drain the publisher key."
  }
}

variable "base_rpc_url" {
  description = "Base RPC endpoint. Base Sepolia until the mainnet audit gate (ADR-0007) is cleared."
  type        = string
  default     = "https://sepolia.base.org"
}

variable "onchain_addresses" {
  description = <<-EOT
    On-chain contract + account addresses for the target chain. Defaults are
    empty so a wrong-chain value is never applied silently -- supply them in the
    tfvars for the environment.
  EOT
  type = object({
    smart_account       = string
    audit_anchor        = string
    policy_registry     = string
    agent_registry      = string
    reputation_registry = string
    escrow              = string
    usdc                = string
  })
  default = {
    smart_account       = ""
    audit_anchor        = ""
    policy_registry     = ""
    agent_registry      = ""
    reputation_registry = ""
    escrow              = ""
    usdc                = ""
  }
}
