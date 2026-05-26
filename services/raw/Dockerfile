# Per-service image for @brain/raw (P1.5).
#
# Multi-process-deployment prep: builds the service + its workspace deps and runs
# as a non-root user. The standalone listening entrypoint (services/raw/dist/main.js)
# lands with the multi-process rollout — today the all-in-one api image
# (root Dockerfile) is the deploy target, and this image validates the per-service
# build graph in CI. Build: `docker build -f services/raw/Dockerfile .`
# TODO(brain-hardening): trim the runtime copy to the exact dist dep-subset and
# add the standalone entrypoint when the service runs as its own process.

# ---- build stage ----
FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @brain/raw... run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 3000
USER node
CMD ["node", "services/raw/dist/main.js"]
