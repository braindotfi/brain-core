#!/usr/bin/env bash
# Full-docker local dev: infra + migrations + API (tsx watch), all in containers.
# Run from the repo root (inside WSL2, with the repo on the native filesystem).
#
#   ./scripts/dev.sh                 # base stack (infra + migrate + api)
#   ./scripts/dev.sh --profile libs  # + cross-package hot reload (tsc -b --watch)
#   ./scripts/dev.sh --profile agents# + Python agents (needs OPENAI_API_KEY + BRAIN_API_TOKEN)
#
# Any extra args are forwarded to `docker compose up`.
set -euo pipefail

cd "$(dirname "$0")/.."

exec docker compose \
  -f docker-compose.yml \
  -f docker-compose.dev.yml \
  up --build "$@"
