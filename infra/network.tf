# ---------------------------------------------------------------------------
# Network (blocker #1)
#
# The scaffold set `public_network_access_enabled = false` on Postgres without
# ever creating a VNet, so nothing could reach the database. This file supplies
# the missing substrate.
#
# Reachability strategy, chosen for cost as much as posture:
#   - Postgres  -> VNet-delegated (native integration, no private endpoint, $0)
#   - Key Vault -> VNet service endpoint + ACL allowing only the apps subnet ($0)
#   - Storage   -> VNet service endpoint + ACL ($0)
#   - Redis     -> private endpoint (~$7/mo; Redis has no delegated-subnet mode
#                  outside Premium, and we are not paying for Premium)
#   - ACR       -> public endpoint, AcrPull via managed identity. Private
#                  endpoints require Premium (+$45/mo) to protect a registry
#                  that stores no secrets. Not worth it.
# ---------------------------------------------------------------------------

resource "azurerm_virtual_network" "main" {
  name                = "${local.name_prefix}-vnet"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  address_space       = [var.vnet_address_space]
  tags                = local.tags
}

# Container Apps infrastructure subnet. A Consumption-only environment requires
# a /23 minimum and the subnet must be dedicated to it.
resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = azurerm_resource_group.primary.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet(var.vnet_address_space, 7, 0)]

  # Reached over service endpoints rather than private endpoints -- see header.
  service_endpoints = ["Microsoft.KeyVault", "Microsoft.Storage"]

  # REQUIRED. Without this the environment fails to create with
  # ManagedEnvironmentSubnetDelegationError. Service endpoints alone are not
  # sufficient -- the subnet must be handed to the Container Apps service.
  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# Postgres Flexible Server VNet integration requires a subnet delegated
# exclusively to it.
resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgres"
  resource_group_name  = azurerm_resource_group.primary.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet(var.vnet_address_space, 8, 4)]

  # Declared to match what Azure does on its own: delegating a subnet to
  # Flexible Server causes the platform to add the Microsoft.Storage service
  # endpoint (the server uses it for backups). Leaving it out of the config
  # does not remove it once -- it produces a permanent diff where every plan
  # tries to strip an endpoint the platform keeps putting back.
  service_endpoints = ["Microsoft.Storage"]

  delegation {
    name = "postgres-flexible"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "private_endpoints" {
  name                 = "snet-private-endpoints"
  resource_group_name  = azurerm_resource_group.primary.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet(var.vnet_address_space, 8, 5)]
}

# ---------------------------------------------------------------------------
# Private DNS -- Postgres
#
# The zone name for a VNet-integrated flexible server must end in
# `.private.postgres.database.azure.com`.
# ---------------------------------------------------------------------------

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${local.name_prefix}.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${local.name_prefix}-pg-link"
  resource_group_name   = azurerm_resource_group.primary.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false
  tags                  = local.tags
}

# ---------------------------------------------------------------------------
# Private DNS + endpoint -- Redis
# ---------------------------------------------------------------------------

resource "azurerm_private_dns_zone" "redis" {
  name                = "privatelink.redis.azure.net"
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "redis" {
  name                  = "${local.name_prefix}-redis-link"
  resource_group_name   = azurerm_resource_group.primary.name
  private_dns_zone_name = azurerm_private_dns_zone.redis.name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "redis" {
  name                = "${local.name_prefix}-redis-pe"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "${local.name_prefix}-redis-psc"
    private_connection_resource_id = azurerm_managed_redis.main.id
    subresource_names              = ["redisEnterprise"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "redis"
    private_dns_zone_ids = [azurerm_private_dns_zone.redis.id]
  }
}
