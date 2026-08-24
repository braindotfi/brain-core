# Container Apps deploy validation scope

Status: scope only. This document does not authorize a Terraform apply, traffic cutover, DNS change, or feature-flag change.

## Goal

Make `deploy-azure-prod.yml` prove that the requested Brain release is running and that every production dependency needed by the API, auth service, worker, agents service, and MCP surface is usable before Container Apps receives public traffic.

## Current gaps

- The root `Dockerfile` accepts `GIT_SHA`, but the ACR build does not pass that build argument. `/health` and `/healthz` can therefore report `commit: "dev"` even when the image tag is SHA-pinned.
- The final deploy check calls only the API Container App `/health` endpoint and asserts only `{"ok":true}`.
- Auth database routes, the worker, agents, MCP, Azure Managed Redis, Azure Blob, and both Key Vault access patterns are not exercised by that check.
- A healthy old revision can satisfy the current check because the response commit is not compared with the requested full SHA.
- Terraform apply can update application revisions before the migration and `db-roles` jobs run. The workflow needs an explicit compatibility rule and a gated promotion sequence, not an assumption that a successful apply makes the release ready.

## Proposed pipeline changes

### 1. Build and release identity

Wire the resolved full commit SHA into every image that reports release identity:

```text
az acr build ... --build-arg GIT_SHA="$SHA" --build-arg SERVICE_VERSION="$VERSION"
```

The implementation must:

- Pass `GIT_SHA` to the root image used by API, auth, and worker.
- Add an equivalent immutable revision identifier to the agents image and its health response.
- Keep SHA-pinned image tags. `latest` remains a convenience tag and must never be the deployment selector.
- Read each live Container App revision's image digest and tag after apply.
- Fail when API, auth, worker, or agents reports a commit other than the requested full SHA for an application deploy.
- For an infra-only deploy, resolve and record the already-deployed application SHA, then validate against that value rather than the Terraform commit.

Acceptance evidence is a redacted release manifest containing the requested SHA, image digests, active revision names, traffic weights, reported service commits, migration execution names, and validation timestamps.

### 2. Pre-apply gates

The workflow should stop before runtime mutation unless all of these pass:

- The requested SHA is a commit reachable from `main`, unless an explicit emergency-release policy permits otherwise.
- The in-VNet Terraform job completes a full plan and reports no unexpected replacement of Postgres, Blob Storage, Managed Redis, Key Vault, Container Apps Environment, or networking resources.
- Every required Key Vault secret exists, is enabled, has a non-placeholder current version, and is accessible to the intended managed identity. Values must never be printed.
- The database migration set is classified as backward compatible with the currently serving revision. A breaking migration requires a separately reviewed expand, migrate, contract sequence.
- The target image digests exist in ACR before Terraform can reference them.

### 3. Apply, migration, and revision sequencing

The target implementation should use a non-serving candidate revision where the service supports multiple revisions:

1. Apply infrastructure and create candidate revisions at zero public traffic.
2. Run `brain-production-migrate`.
3. Run `brain-production-db-roles` after migrations and prove that every service role can perform only its expected operations.
4. Run the validation matrix against direct Container App FQDNs or revision labels, not public DNS.
5. Record a go or no-go result. Traffic movement remains a distinct, manually approved operation.

Single-revision services need an equivalent staged mechanism before implementation. Options to evaluate are temporary validation apps, revision-mode changes, or an explicit compatibility window. The pipeline must not silently replace worker, auth, or agents and call that pre-traffic validation.

## Required live validation matrix

| Surface                   | Live proof required                                                                                                                                                             | Failure condition                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| API                       | `/health` returns 200, `ok:true`, expected service name, exact SHA, expected version, and an explicit on-chain status                                                           | Wrong SHA, malformed response, degraded required capability, or unexpected restart                     |
| Auth                      | `/healthz`, authorization-server metadata, and JWKS all return valid responses with the exact SHA; a disposable register and sign-in flow reaches its database-backed routes    | Static health works but a database-backed route fails, issuer mismatch, invalid JWKS, or wrong SHA     |
| Worker                    | Candidate revision is running with expected SHA and no restart loop; an isolated canary job is accepted, processed once, and produces its expected durable result               | No heartbeat, duplicate processing, stuck job, or wrong SHA                                            |
| Agents                    | Internal `/health` succeeds from inside the environment with expected SHA; one synthetic extraction or grounded agent canary completes through API to agents and back           | Network, token, provider, callback, or version failure                                                 |
| MCP                       | Protected-resource discovery is correct; an unauthenticated request returns the expected challenge; an authorized disposable-tenant read succeeds through the MCP database role | Missing discovery, incorrect auth boundary, role failure, or tenant escape                             |
| Managed Redis             | Authenticated TLS `PING`; namespaced set, get, expiry, and delete; a dedicated BullMQ canary queue enqueues and consumes exactly one job                                        | Authentication failure, plaintext connection, loss of TTL behavior, queue stall, or duplicate delivery |
| Key Vault mounted secrets | Each required Container Apps secret reference resolves for its assigned managed identity; applications start without secret-resolution errors                                   | Missing, disabled, placeholder, denied, or stale secret version                                        |
| Key Vault direct read     | API reads the source-credential encryption key by name using `BRAIN_AZURE_KEY_VAULT_URL` and its managed identity, without exposing the value                                   | RBAC, private endpoint, DNS, or secret lookup failure                                                  |
| Azure Blob                | A namespaced disposable object can be written, read, hash-checked, and removed under the production adapter                                                                     | Credential, network, container policy, integrity, or cleanup failure                                   |
| Postgres                  | Migration version matches the release; auth and service roles connect over TLS; RLS and read-only role canaries behave as designed                                              | Migration drift, role grants missing, non-TLS connection, or isolation failure                         |

Canary resources must use a unique run identifier, remain tenant-scoped, and be deleted or moved to an explicit test-retention state after verification. No canary may run against the Northstar presenter tenant.

## Signup and API-key walkthrough

Before the key-auth flag is enabled, validate a real disposable flow against the candidate endpoints:

1. Register a new user through the same backend path used by BrainMVB.
2. Complete authentication and durable tenancy creation.
3. Prove exactly one tenant, one active bootstrap admin member, and the expected identity link were created.
4. Prove the pending-invite veto still prevents blank-tenant provisioning.
5. Confirm production API-key issuance remains unavailable while `BRAIN_API_KEY_AUTH_ENABLED` is false.

After cutover has been independently approved and observed as stable, use a separate workflow run and approval to flip `BRAIN_API_KEY_AUTH_ENABLED`. Then issue a disposable read-only key, call each allowed commercial read surface, verify use attribution and rate limiting, revoke it, and prove further calls fail. Raw scope exceptions and ordinary-signup demo seeding are separate RFC 0007 work and must not be silently included in this flag change.

## Observability and evidence

The workflow should retain, without secret values:

- Terraform plan and apply result identifiers.
- Image digests, full Git SHA, revision names, replica counts, restart counts, and traffic weights.
- Migration and role-job execution identifiers.
- One result per validation matrix row, including duration and correlation ID.
- Log queries covering startup, secret resolution, Redis authentication, database authorization, and canary execution.
- Cleanup results for all disposable records, queue jobs, Redis keys, and blobs.

Any missing evidence is a failed gate. A warning-only path is not acceptable for a required production dependency.

## Rollback boundary

This pipeline work prepares revisions and validates them. It does not change DNS or move traffic. The later cutover runbook must retain the VM path until the Azure data plane and application revisions have passed validation. API traffic splitting can be used only after stateful services have one authoritative data plane. It must not create concurrent writers against divergent VM and Azure databases.

## Automation and manual gates

Automate image identity checks, plans, secret metadata checks, migration jobs, service probes, dependency canaries, evidence capture, and cleanup. Require manual approval for unexpected Terraform changes, a breaking migration sequence, acceptance of any validation exception, traffic movement, rollback activation, and the later API-key flag flip.

## Checklist

- [x] Current build-argument and health-check gaps identified.
- [x] Required service and dependency validation surfaces scoped.
- [x] Cutover and API-key flag changes explicitly excluded.
- [ ] Implement immutable SHA wiring for root and agents images.
- [ ] Add candidate-revision deployment behavior.
- [ ] Add redacted Key Vault and Managed Redis canaries.
- [ ] Add auth, worker, agents, MCP, Blob, and Postgres validation.
- [ ] Add the disposable signup validation.
- [ ] Test the workflow in a non-production Azure environment.
- [ ] Review and approve the production runbook before any apply or traffic change.
