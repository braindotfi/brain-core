#!/usr/bin/env bash
set -euo pipefail

expected_resource_group=brain-core-staging-api-rg

if [[ "${1:-}" != "--resource-group" || "${2:-}" != "$expected_resource_group" || -n "${3:-}" ]]; then
  echo "usage: $0 --resource-group $expected_resource_group" >&2
  exit 2
fi

resource_group="$2"
group_json="$(az group show --name "$resource_group" --output json)"

if [[ "$(jq -r '.name' <<<"$group_json")" != "$resource_group" ]]; then
  echo "staging resource group lookup returned the wrong group" >&2
  exit 1
fi
if [[ "$(jq -r '.tags.environment // ""' <<<"$group_json")" != "staging" ]]; then
  echo "staging resource group is missing the environment=staging tag" >&2
  exit 1
fi
if jq -e '(.name + "\n" + .id) | test("production"; "i")' <<<"$group_json" >/dev/null; then
  echo "production marker found in the staging resource group name or ID" >&2
  exit 1
fi

resources_json="$(az resource list --resource-group "$resource_group" --output json)"
if jq -e '[.[] | select((.name + "\n" + .id) | test("production"; "i"))] | length > 0' \
  <<<"$resources_json" >/dev/null; then
  echo "production-named resource found inside $resource_group" >&2
  exit 1
fi

echo "staging_resource_group_isolation=verified"
