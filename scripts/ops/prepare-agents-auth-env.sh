#!/usr/bin/env bash
# Render the extraction-agent authentication environment from the host secret file.
# Exactly one credential reaches the container. The unselected rollback credential
# remains host-only until the staged migration is complete.
set -euo pipefail

usage() {
  echo "usage: $0 --env <source-env> --credentials <agent-key-env> --output <agents-auth-env>" >&2
  exit 2
}

source_env=""
credential_env=""
output_env=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || usage
      source_env="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || usage
      output_env="$2"
      shift 2
      ;;
    --credentials)
      [[ $# -ge 2 ]] || usage
      credential_env="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ -n "$source_env" && -n "$credential_env" && -n "$output_env" ]] || usage
[[ -f "$source_env" ]] || { echo "source_env_status=missing"; exit 1; }

read_value() {
  local key="$1"
  local file="${2:-$source_env}"
  local line
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  printf '%s' "${line#*=}"
}

mode="$(read_value BRAIN_AGENTS_AUTH_MODE || true)"
[[ -n "$mode" ]] || mode="legacy_jwt"

tmp="$(mktemp "${output_env}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"

case "$mode" in
  legacy_jwt)
    token="$(read_value BRAIN_API_TOKEN || true)"
    [[ -n "$token" ]] || { echo "BRAIN_API_TOKEN_status=missing_for_legacy_jwt"; exit 1; }
    printf 'BRAIN_API_TOKEN=%s\n' "$token" > "$tmp"
    ;;
  agent_api_key)
    [[ -f "$credential_env" ]] || { echo "agent_credential_file_status=missing"; exit 1; }
    key="$(read_value BRAIN_AGENT_API_KEY "$credential_env" || true)"
    token_url="$(read_value BRAIN_AUTH_TOKEN_URL || true)"
    resource="$(read_value BRAIN_API_RESOURCE_URL || true)"
    [[ -n "$key" ]] || { echo "BRAIN_AGENT_API_KEY_status=missing_for_agent_api_key"; exit 1; }
    [[ "$key" == brain_ak_test_* || "$key" == brain_ak_live_* ]] || {
      echo "BRAIN_AGENT_API_KEY_status=malformed"
      exit 1
    }
    [[ -n "$token_url" ]] || { echo "BRAIN_AUTH_TOKEN_URL_status=missing"; exit 1; }
    [[ -n "$resource" ]] || { echo "BRAIN_API_RESOURCE_URL_status=missing"; exit 1; }
    {
      printf 'BRAIN_AGENT_API_KEY=%s\n' "$key"
      printf 'BRAIN_AUTH_TOKEN_URL=%s\n' "$token_url"
      printf 'BRAIN_API_RESOURCE_URL=%s\n' "$resource"
    } > "$tmp"
    ;;
  *)
    echo "BRAIN_AGENTS_AUTH_MODE_status=unsupported"
    exit 1
    ;;
esac

mv "$tmp" "$output_env"
trap - EXIT
chmod 600 "$output_env"
echo "agents_auth_mode=$mode"
echo "agents_auth_env_status=rendered_one_credential"
