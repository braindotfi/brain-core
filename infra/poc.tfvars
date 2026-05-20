# POC investor demo — single Container App deployment.
#
# Usage:
#   terraform init
#   terraform apply -var-file=poc.tfvars
#
# Deploys only the `api` service (single-process boot binary) alongside the
# shared Postgres, Redis, Blob, ACR, Key Vault, and Front Door resources.
# All other Container Apps (raw, wiki, policy, execution, audit, agents) are
# not created — they are handled internally by the api boot binary.

environment      = "staging"
primary_location = "eastus"
services         = ["api"]
