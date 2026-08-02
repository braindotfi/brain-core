#!/usr/bin/env bash
# Fail before a deploy mutates images or containers when its target env file is
# missing a value required by production compose or an enabled boot fence.
set -euo pipefail

usage() {
  echo "Usage: $0 --compose <docker-compose.yml> --env <environment-file>" >&2
}

compose_file=""
env_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose)
      compose_file="${2:-}"
      shift 2
      ;;
    --env)
      env_file="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$compose_file" || -z "$env_file" ]]; then
  usage
  exit 2
fi
if [[ ! -f "$compose_file" ]]; then
  echo "compose file missing: $compose_file" >&2
  exit 1
fi
if [[ ! -f "$env_file" ]]; then
  echo "environment file missing: $env_file" >&2
  exit 1
fi

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == '""' || "$value" == "''" ]]; then
    value=""
  fi
  printf '%s' "$value"
}

value_for() {
  local key="$1"
  local line value
  line="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    return
  fi
  value="${line#*=}"
  # Docker env-file comments begin after whitespace. Do not treat the
  # placeholder comment in an example env file as a populated secret.
  value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//')"
  trim_value "$value"
}

required_keys=()
add_requirement() {
  local key="$1"
  local existing
  for existing in "${required_keys[@]:-}"; do
    [[ "$existing" == "$key" ]] && return
  done
  required_keys+=("$key")
}

# Compose's ${VAR:?message} syntax is the source of truth for unconditional
# deployment requirements. Strip comment-only lines first so prose examples do
# not become imaginary variables.
while IFS= read -r key; do
  [[ -n "$key" ]] && add_requirement "$key"
done < <(
  sed -E '/^[[:space:]]*#/d' "$compose_file" \
    | grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}]*\}' \
    | sed -E 's/^\$\{([A-Za-z_][A-Za-z0-9_]*):\?.*$/\1/' \
    | sort -u
)

is_enabled() {
  [[ "$(value_for "$1")" == "true" ]]
}

# These requirements are conditional in code, so Compose cannot express them
# with ${VAR:?} without forcing disabled integrations on. Keep this list aligned
# with the named boot fences in services/api, services/auth, and surface-gateway.
if is_enabled BRAIN_API_KEY_AUTH_ENABLED; then
  add_requirement BRAIN_API_KEY_PEPPER
fi
if is_enabled BRAIN_SERVICE_TOKEN_ENABLED; then
  add_requirement BRAIN_SERVICE_TOKEN_SECRET
fi
if is_enabled BRAIN_DEMO_PROVISION_ENABLED; then
  add_requirement BRAIN_DEMO_PROVISION_SECRET
fi
if [[ -n "$(value_for DOCUMENT_EXTRACT_AGENT_URL)" || -n "$(value_for RECONCILIATION_AGENT_URL)" ]]; then
  add_requirement BRAIN_AGENTS_INBOUND_SECRET
fi
if is_enabled BRAIN_SELF_SERVE_SIGNUP; then
  add_requirement EMAIL_ENDPOINT
  add_requirement EMAIL_API_KEY
fi
if is_enabled EMAIL_ENABLED; then
  add_requirement EMAIL_ENDPOINT
  add_requirement EMAIL_API_KEY
  add_requirement EMAIL_APPROVAL_BASE_URL
  add_requirement EMAIL_TOKEN_SECRET
fi
if is_enabled SLACK_ENABLED; then
  add_requirement SLACK_SIGNING_SECRET
fi
if is_enabled TEAMS_ENABLED; then
  add_requirement TEAMS_APP_ID
  add_requirement TEAMS_APP_PASSWORD
fi
if is_enabled BRAIN_SURFACE_SMOKE_ENABLED; then
  add_requirement BRAIN_SURFACE_SMOKE_SECRET
fi

missing=0
while IFS= read -r key; do
  if [[ -z "$(value_for "$key")" ]]; then
    echo "missing secret: $key" >&2
    missing=1
  fi
done < <(printf '%s\n' "${required_keys[@]:-}" | sort)

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo "required compose and boot-fence secrets present: ${#required_keys[@]}"
