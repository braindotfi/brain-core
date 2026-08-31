# Non-secret fixed inputs for the destroyable staging rehearsal foundation.
# Subscription, tenant, principals, run owner, run ID, and expiry are supplied
# by the protected workflow so this file cannot silently target another tenant.

location                       = "canadacentral"
resource_group_name            = "brain-core-staging-api-rg"
vnet_name                      = "brain-core-staging-vnet"
vnet_address_space             = "10.30.0.0/16"
key_vault_name                 = "brain-core-staging-kv"
container_app_environment_name = "brain-core-staging-env"
acr_name                       = "braincorestagingacr"
log_analytics_name             = "brain-core-staging-logs"
log_retention_days             = 30
