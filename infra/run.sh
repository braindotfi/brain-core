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
: "${TF_GIT_SHA:?TF_GIT_SHA is required so runtime validation checks the immutable release}"

# The tag of THIS image. Empty means "same as TF_IMAGE_TAG"; it differs only for
# an infra-only change, where the runner moves and the app images do not. The
# job template persists it, so a plain `job start` does not plan a change to the
# runner's own image.
TF_TERRAFORM_IMAGE_TAG="${TF_TERRAFORM_IMAGE_TAG:-}"

# Auth is the brain-terraform service principal, not managed identity: the
# azurerm state backend pins MSI api-version 2018-02-01 and the Container Apps
# identity endpoint only serves 2019-08-01. ARM_CLIENT_SECRET arrives as a
# Container App secret resolved from Key Vault by the job's managed identity.
: "${ARM_CLIENT_SECRET:?ARM_CLIENT_SECRET is required (Key Vault secret terraform-client-secret)}"

# Optional space-separated list of resource addresses to restrict the run to.
# Unset (the default) plans the whole config. This exists because the config
# can hold more than one change in flight at a time, and an apply for one of
# them should not sweep in unrelated pending work that merely shares the repo.
TARGET_ARGS=()
for addr in ${TF_TARGET:-}; do
  TARGET_ARGS+=(-target="$addr")
done

cd /infra

echo "==> terraform init"
terraform init -backend-config=backend-production.hcl -input=false

echo "==> terraform plan (image_tag=${TF_IMAGE_TAG}, terraform_image_tag=${TF_TERRAFORM_IMAGE_TAG:-<same>}, target=${TF_TARGET:-<all>})"
terraform plan -var-file=production.tfvars \
  -var="image_tag=${TF_IMAGE_TAG}" \
  -var="git_sha=${TF_GIT_SHA}" \
  -var="terraform_image_tag=${TF_TERRAFORM_IMAGE_TAG}" \
  "${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"}" \
  -input=false -no-color -out=/tmp/tfplan

# Re-print just the action lines at the END of the run. The Container Apps log
# API caps a fetch at the last 300 lines, and a full plan is far longer than
# that, so without this the list of what an apply would actually touch scrolls
# out of reach and the plan cannot be reviewed before approving it.
echo "==> plan summary (resource actions)"
terraform show -no-color /tmp/tfplan | grep -E '^  # ' || echo "(no resource changes)"

if [ "$ACTION" = "apply" ]; then
  echo "==> terraform apply"
  terraform apply -input=false -no-color /tmp/tfplan
else
  echo "==> plan only; set ACTION=apply to execute"
fi
