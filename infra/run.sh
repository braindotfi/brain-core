#!/bin/bash
# Entrypoint for the in-VNet Terraform runner.
#
# ACTION=plan (default) or apply. Anything else is rejected rather than passed
# through to terraform -- this runs with Contributor on the subscription.
set -euo pipefail

ACTION="${ACTION:-plan}"
case "$ACTION" in
  plan|apply) ;;
  *) echo "refusing unknown ACTION '$ACTION' (expected plan or apply)" >&2; exit 2 ;;
esac

: "${TF_IMAGE_TAG:?TF_IMAGE_TAG is required so the apply pins the images it deploys}"

# Auth is the brain-terraform service principal, not managed identity: the
# azurerm state backend pins MSI api-version 2018-02-01 and the Container Apps
# identity endpoint only serves 2019-08-01. ARM_CLIENT_SECRET arrives as a
# Container App secret resolved from Key Vault by the job's managed identity.
: "${ARM_CLIENT_SECRET:?ARM_CLIENT_SECRET is required (Key Vault secret terraform-client-secret)}"

cd /infra

echo "==> terraform init"
terraform init -backend-config=backend-production.hcl -input=false

echo "==> terraform plan (image_tag=${TF_IMAGE_TAG})"
terraform plan -var-file=production.tfvars \
  -var="image_tag=${TF_IMAGE_TAG}" \
  -input=false -no-color -out=/tmp/tfplan

if [ "$ACTION" = "apply" ]; then
  echo "==> terraform apply"
  terraform apply -input=false -no-color /tmp/tfplan
else
  echo "==> plan only; set ACTION=apply to execute"
fi
