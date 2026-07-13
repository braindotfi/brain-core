# ---- dev stage ----
# Used by docker-compose.dev.yml for the full-docker local dev loop. Provides the
# Node 22 + pnpm 9.12 toolchain only; dependencies are installed at container start
# against the bind-mounted source (and persisted in a named node_modules volume), so
# the image stays generic and never carries a stale install. No build, no prod prune.
FROM node:22-slim AS dev
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
WORKDIR /app
# Overridden per-service by docker-compose.dev.yml; sane default = run the API in watch mode.
CMD ["pnpm", "-C", "services/api", "run", "dev"]

# ---- build stage ----
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

WORKDIR /app

# Copy workspace manifests first — cache bust only when deps change
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY schemas/package.json schemas/tsconfig.json schemas/
COPY shared/package.json shared/tsconfig.json shared/
# packages/* are workspace members (deps of services/surface-gateway). The
# frozen install resolves the full workspace graph, so their manifests must be
# present here even though the api image does not import them.
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/surfaces/package.json packages/surfaces/tsconfig.json packages/surfaces/
COPY services/api/package.json services/api/tsconfig.json services/api/
COPY services/raw/package.json services/raw/tsconfig.json services/raw/
COPY services/canonical/package.json services/canonical/tsconfig.json services/canonical/
COPY services/ledger/package.json services/ledger/tsconfig.json services/ledger/
COPY services/wiki/package.json services/wiki/tsconfig.json services/wiki/
COPY services/policy/package.json services/policy/tsconfig.json services/policy/
COPY services/execution/package.json services/execution/tsconfig.json services/execution/
COPY services/agent-router/package.json services/agent-router/tsconfig.json services/agent-router/
COPY services/internal-agents/package.json services/internal-agents/tsconfig.json services/internal-agents/
COPY services/mcp/package.json services/mcp/tsconfig.json services/mcp/
COPY services/audit/package.json services/audit/tsconfig.json services/audit/
COPY services/surface-gateway/package.json services/surface-gateway/tsconfig.json services/surface-gateway/
COPY clients/sdk/package.json clients/sdk/tsconfig.json clients/sdk/
COPY tools/migrate/package.json tools/migrate/tsconfig.json tools/migrate/
COPY tools/static-jwks/package.json tools/static-jwks/tsconfig.json tools/static-jwks/
COPY tools/seed-golden-path/package.json tools/seed-golden-path/tsconfig.json tools/seed-golden-path/
COPY tools/dev-token/package.json tools/dev-token/tsconfig.json tools/dev-token/
COPY tools/plaid-sandbox/package.json tools/plaid-sandbox/tsconfig.json tools/plaid-sandbox/
COPY tools/demo-reset/package.json tools/demo-reset/tsconfig.json tools/demo-reset/
COPY tests/e2e/package.json tests/e2e/tsconfig.json tests/e2e/
COPY tests/invariants/package.json tests/invariants/tsconfig.json tests/invariants/
COPY tests/adversarial/package.json tests/adversarial/tsconfig.json tests/adversarial/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

# tools/migrate dist is copied into the runtime image (migration runner) but is
# excluded from the `pnpm run build` service filter; build it so the COPY finds it.
RUN pnpm -C tools/migrate run build
# static-jwks (the JWKS sidecar) and dev-token (mint test JWTs) are likewise
# excluded from the service-filtered build; build them for the runtime image.
RUN pnpm -C tools/static-jwks run build
RUN pnpm -C tools/dev-token run build
# seed-golden-path: demo-data seeder for the `seed` profile (docker-compose.prod.yml).
RUN pnpm -C tools/seed-golden-path run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# SERVICE_VERSION is the single source of truth reported by /health. CI bakes it
# in from `git describe` (build-arg below); local builds fall back to 0.0.0-dev.
# Do NOT set SERVICE_VERSION via environment:/env_file at runtime — that overrides
# this baked value and re-pins a stale version. Humans only move the base semver
# by tagging a tier (v0.1.0, v1.0.0); the -N-gSHA suffix is automatic.
ARG SERVICE_VERSION=0.0.0-dev
ENV SERVICE_VERSION=$SERVICE_VERSION

RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

WORKDIR /app

# Workspace manifests for pnpm symlink reconstruction
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY schemas/package.json schemas/
COPY shared/package.json shared/
# packages/* manifests needed for the frozen --prod install's workspace graph.
# API imports @brain/surfaces for onboarding email delivery; surface-gateway
# imports both @brain/surfaces and @brain/core.
COPY packages/core/package.json packages/core/
COPY packages/surfaces/package.json packages/surfaces/
COPY services/api/package.json services/api/
COPY services/raw/package.json services/raw/
COPY services/canonical/package.json services/canonical/
COPY services/ledger/package.json services/ledger/
COPY services/wiki/package.json services/wiki/
COPY services/policy/package.json services/policy/
COPY services/execution/package.json services/execution/
COPY services/agent-router/package.json services/agent-router/
COPY services/internal-agents/package.json services/internal-agents/
COPY services/mcp/package.json services/mcp/
COPY services/audit/package.json services/audit/
COPY services/surface-gateway/package.json services/surface-gateway/
COPY clients/sdk/package.json clients/sdk/
COPY tools/migrate/package.json tools/migrate/
COPY tools/static-jwks/package.json tools/static-jwks/
COPY tools/seed-golden-path/package.json tools/seed-golden-path/
COPY tools/dev-token/package.json tools/dev-token/
COPY tools/plaid-sandbox/package.json tools/plaid-sandbox/
COPY tools/demo-reset/package.json tools/demo-reset/
COPY tests/e2e/package.json tests/e2e/
COPY tests/invariants/package.json tests/invariants/
COPY tests/adversarial/package.json tests/adversarial/

RUN pnpm install --frozen-lockfile --prod

# Built artifacts from builder
COPY --from=builder /app/schemas/dist schemas/dist
# Raw entity/relation JSON Schemas — the Wiki loadRegistry() reads these from
# schemas/{entity,relation}/*.schema.json at boot (services/wiki/src/schemas.ts);
# they live in the schemas package source, NOT in schemas/dist, so the runtime
# image must carry them or the API crashes at startup.
COPY --from=builder /app/schemas/entity schemas/entity
COPY --from=builder /app/schemas/relation schemas/relation
COPY --from=builder /app/shared/dist shared/dist
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/surfaces/dist packages/surfaces/dist
COPY --from=builder /app/services/api/dist services/api/dist
# OpenAPI spec for the /v1/docs UI. `services/api` build runs copy-spec to
# generate services/api/assets/openapi.yaml; the runtime loader (docs/spec.ts)
# reads it at boot, so without this COPY the /v1/docs plugin throws and the api
# crash-loops in prod.
COPY --from=builder /app/services/api/assets services/api/assets
COPY --from=builder /app/services/raw/dist services/raw/dist
COPY --from=builder /app/services/canonical/dist services/canonical/dist
COPY --from=builder /app/services/ledger/dist services/ledger/dist
COPY --from=builder /app/services/wiki/dist services/wiki/dist
COPY --from=builder /app/services/policy/dist services/policy/dist
COPY --from=builder /app/services/execution/dist services/execution/dist
COPY --from=builder /app/services/agent-router/dist services/agent-router/dist
COPY --from=builder /app/services/internal-agents/dist services/internal-agents/dist
COPY --from=builder /app/services/mcp/dist services/mcp/dist
COPY --from=builder /app/services/audit/dist services/audit/dist
COPY --from=builder /app/services/surface-gateway/dist services/surface-gateway/dist
COPY --from=builder /app/clients/sdk/dist clients/sdk/dist
COPY --from=builder /app/tools/migrate/dist tools/migrate/dist
COPY --from=builder /app/tools/static-jwks/dist tools/static-jwks/dist
COPY --from=builder /app/tools/dev-token/dist tools/dev-token/dist
COPY --from=builder /app/tools/seed-golden-path/dist tools/seed-golden-path/dist

# Migration SQL files. The migrate CLI discovers services/<svc>/migrations/*.sql
# relative to the repo root (cwd). Without these the same runtime image cannot
# double as the one-shot `migrate` service (docker-compose.prod.yml), since the
# build stage's `COPY . .` does not survive into this stage.
COPY --from=builder /app/services/api/migrations services/api/migrations
COPY --from=builder /app/services/audit/migrations services/audit/migrations
COPY --from=builder /app/services/canonical/migrations services/canonical/migrations
COPY --from=builder /app/services/execution/migrations services/execution/migrations
COPY --from=builder /app/services/ledger/migrations services/ledger/migrations
COPY --from=builder /app/services/policy/migrations services/policy/migrations
COPY --from=builder /app/services/raw/migrations services/raw/migrations
COPY --from=builder /app/services/surface-gateway/migrations services/surface-gateway/migrations
COPY --from=builder /app/services/wiki/migrations services/wiki/migrations

# Committed external-audit record. The mainnet escrow boot fence
# (composition/escrow-audit-gate.ts -> readAuditStatusApproved) reads this file
# at startup; without it the fence fails closed and mainnet escrow could never
# boot even after a completed audit. The .dockerignore re-includes only this one
# file from the otherwise-excluded contracts/ tree.
COPY --from=builder /app/contracts/audit-status.json contracts/audit-status.json

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "services/api/dist/main.js"]
