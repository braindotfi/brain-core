# Backend config for the production stack.
#   terraform init -backend-config=backend-production.hcl
#
# These values come from `terraform output backend_config` in infra/bootstrap.
# Holds no secrets — access is by Azure AD identity, not a stored key.

resource_group_name  = "brain-tfstate-rg"
storage_account_name = "brainfitfstate"
container_name       = "tfstate"
key                  = "production.terraform.tfstate"
use_azuread_auth     = true
