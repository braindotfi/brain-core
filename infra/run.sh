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

# Container Apps does NOT expose IMDS (169.254.169.254). It injects an
# App Service-style identity endpoint instead, so Terraform's managed-identity
# authorizer must be pointed at it explicitly or it fails with
# "dial tcp 169.254.169.254:80: connect: connection refused".
if [ -n "${IDENTITY_ENDPOINT:-}" ]; then
  export ARM_MSI_ENDPOINT="$IDENTITY_ENDPOINT"
  echo "==> using Container Apps identity endpoint"
else
  echo "==> WARNING: IDENTITY_ENDPOINT unset; falling back to IMDS (will fail here)" >&2
fi

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
