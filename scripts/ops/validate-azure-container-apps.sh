#!/usr/bin/env bash
# Control-plane readiness for the release. Private dependency behavior is
# validated separately by the in-VNet deploy-validation Container App Job.
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"
: "${AZURE_ACR:?AZURE_ACR is required}"
: "${AZURE_IMAGE_TAG:?AZURE_IMAGE_TAG is required}"
: "${EXPECTED_GIT_SHA:?EXPECTED_GIT_SHA is required}"
: "${AZURE_LOG_ANALYTICS_WORKSPACE_ID:?AZURE_LOG_ANALYTICS_WORKSPACE_ID is required}"

if [[ ! "$EXPECTED_GIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::EXPECTED_GIT_SHA must be a full lowercase commit SHA"
  exit 1
fi

check_app() {
  local app="$1"
  local image_repo="$2"
  local expected_image="${AZURE_ACR}.azurecr.io/${image_repo}:${AZURE_IMAGE_TAG}"
  local revision
  revision=$(az containerapp show -n "$app" -g "$AZURE_RESOURCE_GROUP" \
    --query properties.latestRevisionName -o tsv)
  if [ -z "$revision" ]; then
    echo "::error::$app has no latest revision"
    return 1
  fi

  local state
  state=$(az containerapp revision show -n "$app" -g "$AZURE_RESOURCE_GROUP" \
    --revision "$revision" \
    --query '[properties.provisioningState,properties.healthState,properties.template.containers[0].image]' \
    -o tsv)
  local provisioning health image
  IFS=$'\t' read -r provisioning health image <<<"$state"
  if [ "$provisioning" != "Provisioned" ] || [ "$health" != "Healthy" ]; then
    echo "::error::$app revision $revision is provisioning=$provisioning health=$health"
    return 1
  fi
  if [ "$image" != "$expected_image" ]; then
    echo "::error::$app revision $revision runs an unexpected image"
    return 1
  fi

  local replicas restarts
  replicas=$(az containerapp replica list -n "$app" -g "$AZURE_RESOURCE_GROUP" \
    --revision "$revision" -o json)
  if [ "$(jq 'length' <<<"$replicas")" -lt 1 ]; then
    echo "::error::$app revision $revision has no running replica"
    return 1
  fi
  restarts=$(jq '[.[].properties.containers[]?.restartCount // 0] | add // 0' <<<"$replicas")
  if [ "$restarts" -ne 0 ]; then
    echo "::error::$app revision $revision has $restarts container restarts"
    return 1
  fi

  local unresolved
  unresolved=$(az containerapp show -n "$app" -g "$AZURE_RESOURCE_GROUP" -o json |
    jq '[.properties.configuration.secrets[]? | select(.keyVaultUrl != null and (.identity == null or .identity == ""))] | length')
  if [ "$unresolved" -ne 0 ]; then
    echo "::error::$app has Key Vault references without an assigned identity"
    return 1
  fi
  echo "$app: revision=$revision replicas=$(jq 'length' <<<"$replicas") restarts=0 image_tag=$AZURE_IMAGE_TAG"
}

check_app brain-production-api brain-api
check_app brain-production-auth brain-api
check_app brain-production-worker brain-api
check_app brain-production-agents brain-agents

# Worker has no ingress. Its release identity and replica state are control-plane
# gates above. This log check proves the worker process reached its functional
# boot path, while Redis queue semantics are exercised by the in-VNet job.
worker_boots=$(az monitor log-analytics query -w "$AZURE_LOG_ANALYTICS_WORKSPACE_ID" \
  --analytics-query "ContainerAppConsoleLogs_CL
    | where TimeGenerated > ago(2h)
    | where ContainerAppName_s == 'brain-production-worker'
    | where Log_s has 'brain-server up'
    | summarize Count=count()" \
  --query '[0].Count' -o tsv)
if [ -z "$worker_boots" ] || [ "$worker_boots" -lt 1 ]; then
  echo "::error::worker has no successful boot evidence in the last two hours"
  exit 1
fi
echo "worker runtime boot evidence: present"
