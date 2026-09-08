#!/usr/bin/env bash
# Create the host-only API credential when absent, then render an app env file
# that contains the scoped S3 names and no MinIO credential-source variables.
set -euo pipefail

usage() {
  echo "usage: $0 --env <source-env> --credentials <credential-env> --output <api-env>" >&2
  exit 2
}

source_env=""
credential_env=""
api_env=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || usage
      source_env="$2"
      shift 2
      ;;
    --credentials)
      [[ $# -ge 2 ]] || usage
      credential_env="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || usage
      api_env="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ -n "$source_env" && -n "$credential_env" && -n "$api_env" ]] || usage
[[ -f "$source_env" ]] || { echo "source_env_status=missing"; exit 1; }

read_value() {
  local key="$1"
  local file="$2"
  local line
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  printf '%s' "${line#*=}"
}

replace_or_append() {
  local key="$1"
  local value="$2"
  local input="$3"
  local output="$4"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" {
      if (replaced == 0) {
        print key "=" value
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (replaced == 0) print key "=" value
    }
  ' "$input" > "$output"
}

credential_dir="$(dirname "$credential_env")"
mkdir -p "$credential_dir"
touch "$credential_env"
chmod 600 "$credential_env"

root_access_key="$(read_value MINIO_ROOT_USER "$source_env" || true)"
root_secret_key="$(read_value MINIO_ROOT_PASSWORD "$source_env" || true)"
if [[ -z "$root_access_key" || -z "$root_secret_key" ]]; then
  echo "minio_root_credential_status=missing_or_blank"
  exit 1
fi
if [[ "$root_access_key" == "brain-api" ]]; then
  echo "minio_root_credential_status=conflicts_with_api_identity"
  exit 1
fi

access_key="$(read_value MINIO_API_ACCESS_KEY_ID "$credential_env" || true)"
if [[ -n "$access_key" && "$access_key" != "brain-api" ]]; then
  echo "MINIO_API_ACCESS_KEY_ID_status=unexpected_value"
  exit 1
fi

changed=false
if [[ "$access_key" != "brain-api" ]]; then
  tmp="$(mktemp "${credential_env}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  replace_or_append MINIO_API_ACCESS_KEY_ID brain-api "$credential_env" "$tmp"
  mv "$tmp" "$credential_env"
  access_key=brain-api
  changed=true
fi

secret_key="$(read_value MINIO_API_SECRET_ACCESS_KEY "$credential_env" || true)"
normalized_secret="$(printf '%s' "$secret_key" | tr '[:upper:]' '[:lower:]')"
case "$normalized_secret" in
  ""|brain|brain-api|changeme|password|minioadmin)
    secret_key="$(openssl rand -hex 32)"
    tmp="$(mktemp "${credential_env}.tmp.XXXXXX")"
    chmod 600 "$tmp"
    replace_or_append MINIO_API_SECRET_ACCESS_KEY "$secret_key" "$credential_env" "$tmp"
    mv "$tmp" "$credential_env"
    changed=true
    ;;
esac
if [[ "$secret_key" == "$root_secret_key" ]]; then
  echo "api_secret_status=conflicts_with_root"
  exit 1
fi

api_tmp="$(mktemp "${api_env}.tmp.XXXXXX")"
chmod 600 "$api_tmp"
awk '
  /^(MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|MINIO_API_ACCESS_KEY_ID|MINIO_API_SECRET_ACCESS_KEY|MINIO_WORKER_ACCESS_KEY_ID|MINIO_WORKER_SECRET_ACCESS_KEY|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY)=/ { next }
  { print }
' "$source_env" > "$api_tmp"
{
  printf '\nS3_ACCESS_KEY_ID=%s\n' "$access_key"
  printf 'S3_SECRET_ACCESS_KEY=%s\n' "$secret_key"
} >> "$api_tmp"
mv "$api_tmp" "$api_env"
chmod 600 "$api_env"

if [[ "$changed" == true ]]; then
  echo "api_credential_status=created_or_repaired"
else
  echo "api_credential_status=preserved"
fi
echo "api_access_key_status=brain-api"
echo "api_env_status=rendered_without_root"
