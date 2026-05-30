# Audit Area: Runtime

**Scope:** The actual runtime behaviour of the deployed system. Boot sequence, worker registration, process composition, shutdown, and the gap between the "modular service" presentation and the single-process reality.

**Reports planned:**

- `boot.md`. Deep audit of `services/api/src/main.ts`: Fastify composition order, worker startup (`startNormalizeWorker`, `startOutboxWorker`, `createAgentRouteWorker`, `anchorBroadcaster`), error-on-boot failure modes, graceful shutdown, per-service Dockerfile status (CI-only vs live).

**Out of scope here:** Per-service business logic (see `services/`), infrastructure provisioning (see `infrastructure/`).

**Relevant files:** `services/api/src/main.ts`, root `Dockerfile`, per-service `Dockerfile`s, `docker-compose.yml`, `docker-compose.smoke.yml`.
