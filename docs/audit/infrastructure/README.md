# Audit Area: Infrastructure

**Scope:** Terraform provisioning (`infra/`), Docker Compose local dev stack, per-service Dockerfiles, and the gap between declared infrastructure and what's actually reachable.

**Reports planned:**

- `terraform-and-compose.md`. `infra/main.tf` (23 Azure resources: Container Apps, Postgres, Redis, Blob, ACR, Key Vault, Log Analytics, Front Door), `docker-compose.yml` (infra-only: Postgres, Redis, LocalStack, Python agents), `docker-compose.smoke.yml` (golden-path smoke stack), per-service Dockerfiles (added P1.5. CI validation only; TODO: standalone entrypoints when services split). Gap analysis: what's declared vs what runs.

**Key finding to validate:** Per-service Dockerfiles (`services/audit/Dockerfile`, etc.) build the service's workspace but their `CMD` references a `dist/main.js` that does not yet exist in those services (no standalone entrypoint). These images validate the build graph in CI but cannot run as independent containers today. The root `Dockerfile` remains the only live deploy unit.

**Relevant files:** `infra/main.tf`, `infra/variables.tf`, `infra/db-roles.sql`, `docker-compose.yml`, `docker-compose.smoke.yml`, `services/*/Dockerfile`, root `Dockerfile`.
