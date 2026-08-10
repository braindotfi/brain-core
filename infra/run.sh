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
  # ...and the endpoint only speaks 2019-08-01. The authorizer defaults to
  # IMDS's 2018-02-01, which this endpoint rejects with UnsupportedApiVersion.
  export ARM_MSI_API_VERSION="${ARM_MSI_API_VERSION:-2019-08-01}"
  echo "==> using Container Apps identity endpoint (api-version ${ARM_MSI_API_VERSION})"
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
