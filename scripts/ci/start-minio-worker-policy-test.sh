#!/usr/bin/env bash
set -euo pipefail

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${MINIO_WORKER_ACCESS_KEY_ID:?MINIO_WORKER_ACCESS_KEY_ID is required}"
: "${MINIO_WORKER_SECRET_ACCESS_KEY:?MINIO_WORKER_SECRET_ACCESS_KEY is required}"
: "${MINIO_API_ACCESS_KEY_ID:?MINIO_API_ACCESS_KEY_ID is required}"
: "${MINIO_API_SECRET_ACCESS_KEY:?MINIO_API_SECRET_ACCESS_KEY is required}"

container_name="brain-minio-worker-policy-test"
docker rm -f "$container_name" >/dev/null 2>&1 || true
docker run -d --name "$container_name" \
  -p 9000:9000 \
  -e MINIO_ROOT_USER \
  -e MINIO_ROOT_PASSWORD \
  quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e \
  server /data >/dev/null

ready=false
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9000/minio/health/ready >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { docker logs "$container_name"; exit 1; }

policy_path="$(pwd)/infra/minio/brain-worker-artifacts-v1.json"
api_policy_path="$(pwd)/infra/minio/brain-api-artifacts-v1.json"
docker run --rm \
  --network "container:$container_name" \
  -e MINIO_ROOT_USER \
  -e MINIO_ROOT_PASSWORD \
  -e MINIO_WORKER_ACCESS_KEY_ID \
  -e MINIO_WORKER_SECRET_ACCESS_KEY \
  -e MINIO_API_ACCESS_KEY_ID \
  -e MINIO_API_SECRET_ACCESS_KEY \
  -v "$policy_path:/policy.json:ro" \
  -v "$api_policy_path:/api-policy.json:ro" \
  --entrypoint /bin/sh \
  quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z@sha256:c0d345a438dcac5677c1158e4ac46637069b67b3cc38e7b04c08cf93bdee4a62 -c '
    set -eu
    mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mc mb --with-lock --ignore-existing local/brain-artifacts
    mc admin policy create local brain-worker-artifacts-v1 /policy.json
    mc admin user add local "$MINIO_WORKER_ACCESS_KEY_ID" "$MINIO_WORKER_SECRET_ACCESS_KEY"
    mc admin policy attach local brain-worker-artifacts-v1 --user "$MINIO_WORKER_ACCESS_KEY_ID"
    mc admin policy create local brain-api-artifacts-v1 /api-policy.json
    mc admin user add local "$MINIO_API_ACCESS_KEY_ID" "$MINIO_API_SECRET_ACCESS_KEY"
    mc admin policy attach local brain-api-artifacts-v1 --user "$MINIO_API_ACCESS_KEY_ID"
  '

echo "minio_scoped_policy_fixture=ready"
