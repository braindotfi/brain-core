# ---- build stage ----
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy workspace manifests first — cache bust only when deps change
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY schemas/package.json schemas/tsconfig.json schemas/
COPY shared/package.json shared/tsconfig.json shared/
COPY services/api/package.json services/api/tsconfig.json services/api/
COPY services/raw/package.json services/raw/tsconfig.json services/raw/
COPY services/ledger/package.json services/ledger/tsconfig.json services/ledger/
COPY services/wiki/package.json services/wiki/tsconfig.json services/wiki/
COPY services/policy/package.json services/policy/tsconfig.json services/policy/
COPY services/execution/package.json services/execution/tsconfig.json services/execution/
COPY services/mcp/package.json services/mcp/tsconfig.json services/mcp/
COPY services/audit/package.json services/audit/tsconfig.json services/audit/
COPY clients/sdk/package.json clients/sdk/tsconfig.json clients/sdk/
COPY tools/migrate/package.json tools/migrate/tsconfig.json tools/migrate/
COPY tools/seed-golden-path/package.json tools/seed-golden-path/tsconfig.json tools/seed-golden-path/
COPY tools/dev-token/package.json tools/dev-token/tsconfig.json tools/dev-token/
COPY tools/plaid-sandbox/package.json tools/plaid-sandbox/tsconfig.json tools/plaid-sandbox/
COPY tests/e2e/package.json tests/e2e/tsconfig.json tests/e2e/
COPY tests/invariants/package.json tests/invariants/tsconfig.json tests/invariants/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Workspace manifests for pnpm symlink reconstruction
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY schemas/package.json schemas/
COPY shared/package.json shared/
COPY services/api/package.json services/api/
COPY services/raw/package.json services/raw/
COPY services/ledger/package.json services/ledger/
COPY services/wiki/package.json services/wiki/
COPY services/policy/package.json services/policy/
COPY services/execution/package.json services/execution/
COPY services/mcp/package.json services/mcp/
COPY services/audit/package.json services/audit/
COPY clients/sdk/package.json clients/sdk/
COPY tools/migrate/package.json tools/migrate/
COPY tools/seed-golden-path/package.json tools/seed-golden-path/
COPY tools/dev-token/package.json tools/dev-token/
COPY tools/plaid-sandbox/package.json tools/plaid-sandbox/
COPY tests/e2e/package.json tests/e2e/
COPY tests/invariants/package.json tests/invariants/

RUN pnpm install --frozen-lockfile --prod

# Built artifacts from builder
COPY --from=builder /app/schemas/dist schemas/dist
COPY --from=builder /app/shared/dist shared/dist
COPY --from=builder /app/services/api/dist services/api/dist
COPY --from=builder /app/services/raw/dist services/raw/dist
COPY --from=builder /app/services/ledger/dist services/ledger/dist
COPY --from=builder /app/services/wiki/dist services/wiki/dist
COPY --from=builder /app/services/policy/dist services/policy/dist
COPY --from=builder /app/services/execution/dist services/execution/dist
COPY --from=builder /app/services/mcp/dist services/mcp/dist
COPY --from=builder /app/services/audit/dist services/audit/dist
COPY --from=builder /app/clients/sdk/dist clients/sdk/dist
COPY --from=builder /app/tools/migrate/dist tools/migrate/dist

EXPOSE 3000

CMD ["node", "services/api/dist/main.js"]
