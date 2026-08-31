# Backend for the destroyable Azure staging foundation.
#
# The storage account and container are created by infra/bootstrap-staging.
# This file contains no credential. GitHub Actions authenticates through the
# staging-only OIDC principal and Azure CLI token cache.

resource_group_name  = "brain-core-staging-tfstate-rg"
storage_account_name = "braincoretfstatestg"
container_name       = "tfstate-core-staging"
key                  = "foundation.terraform.tfstate"
use_azuread_auth     = true
use_cli              = true
