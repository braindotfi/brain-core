# Backend for the encrypted staging migration intake root.
# Uses the staging-only account with a state key separate from the foundation.

resource_group_name  = "brain-core-staging-tfstate-rg"
storage_account_name = "braincoretfstatestg"
container_name       = "tfstate-core-staging"
key                  = "migration-intake.terraform.tfstate"
use_azuread_auth     = true
use_cli              = true
