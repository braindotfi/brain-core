# Per-service image for @brain/surface-gateway.
#
# Build: `docker build -f services/surface-gateway/Dockerfile .`

FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @brain/surface-gateway... run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 3000
USER node
CMD ["node", "services/surface-gateway/dist/main.js"]
