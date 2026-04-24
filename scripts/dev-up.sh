#!/usr/bin/env bash
# Brain local dev stack — start Postgres + Redis + LocalStack.
# Idempotent: re-running is safe.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required but not installed." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "error: docker compose plugin is required." >&2
  exit 1
fi

echo "==> starting brain local stack (postgres, redis, localstack)"
docker compose up -d

echo "==> waiting for healthchecks"
for svc in postgres redis localstack; do
  printf "  %-10s " "$svc"
  for _ in {1..60}; do
    status="$(docker inspect --format='{{.State.Health.Status}}' "brain-$svc" 2>/dev/null || echo starting)"
    if [ "$status" = "healthy" ]; then
      echo "ok"
      break
    fi
    sleep 1
  done
  if [ "$status" != "healthy" ]; then
    echo "failed (status=$status)"
    exit 1
  fi
done

echo "==> stack ready"
echo "  postgres   : postgres://brain:brain@localhost:5432/brain"
echo "  redis      : redis://localhost:6379"
echo "  localstack : http://localhost:4566"
