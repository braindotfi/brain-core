# VM production API-key authentication enablement scope

Status: scoped only. This document does not authorize a production environment
change, service recreation, API-key issuance, or feature-flag flip.

Target: the current VM production stack at `api.brain.fi`, using the
host-managed `~/brain-core/.env.prod` file and Docker Compose project
`brain-prod`. Container Apps, Azure staging, Terraform, DNS, and traffic changes
are outside this scope.

## Decision

Enabling `BRAIN_API_KEY_AUTH_ENABLED` on the current production VM is a guarded
host environment-file update, not a Terraform or infrastructure change.

The production API service loads `.env.prod` through `docker-compose.prod.yml`.
The production promotion workflow explicitly leaves that file on the host. The
API reads the flag, pepper, and per-key rate-limit settings at process startup.
It mounts API-key authentication and key lifecycle routes only when the flag is
true, and it refuses to boot when the flag is true without a non-empty
`BRAIN_API_KEY_PEPPER`.

The existing staging VM establishes the operational pattern. Its deploy job
atomically upserts these four settings into `.env.staging`, preserves a dated
backup, runs the required-secret guard, recreates the API, checks health, and
runs the API-key lifecycle acceptance test:

- `BRAIN_API_KEY_AUTH_ENABLED=true`
- `BRAIN_API_KEY_PEPPER=<environment-specific secret>`
- `BRAIN_EDGE_RATE_LIMIT=100000` for coarse IP abuse protection. Commercial
  key and tenant limits are read from server-owned entitlements.
- `BRAIN_API_KEY_RATE_LIMIT_TIMEOUT_MS=2000` so Redis faults fail closed within
  a bounded interval.

PR #582 supplies the appropriate control pattern for production: a fixed,
target-bounded workflow, the protected `production` GitHub environment, the
`promote-prod` concurrency group, atomic environment-file replacement, a
single-service recreate, and public verification. Production enablement should
be a new production-only gated ops workflow. It must not be added to
`promote-prod.yml`, because a routine application deployment must never make
this independent go or no-go decision.

## Verified repository and endpoint findings

Repository findings on 2026-08-31:

- `.env.prod.example` deliberately defaults
  `BRAIN_API_KEY_AUTH_ENABLED=false` and documents that the pepper is required
  when enabled.
- `services/api/src/main.ts` creates the API-key authenticator and registers the
  `/v1/tenants/:tenantId/keys`, `/v1/keys/:id/rotate`,
  `/v1/keys/:id`, and `/v1/tenants/:tenantId/usage` routes only when the flag is
  true.
- `scripts/check-required-compose-secrets.sh` fails before recreation when the
  flag is true and `BRAIN_API_KEY_PEPPER` is absent. It prints missing variable
  names, never values.
- `main.yml` enables the feature on the staging VM with
  `BRAIN_API_KEY_PEPPER_STAGING` and runs
  `scripts/ops/staging_api_key_acceptance.py` after deployment.
- `promote-prod.yml` does not edit API-key settings and does not run a production
  API-key acceptance test.
- A read-only request to `https://api.brain.fi/health` returned healthy commit
  `20c8443a84611f66ef293434420f89b7c4f50d65` during this investigation. An
  unauthenticated request to a key-management path returned
  `auth_token_missing`; the global authentication hook runs before route
  resolution, so that response does not prove whether the flag is enabled.
  The workflow must inspect variable presence and the API container's boolean
  setting without printing values.

No database migration is required. Migration `0017_api_keys_contract.sql` and
the API-key route implementation are already part of the application. No
Terraform resource is read by this VM runtime path.

### Secret inventory boundary

The GitHub API confirms that the visible repository secret inventory contains
`BRAIN_API_KEY_PEPPER_STAGING` and no production API-key pepper. It also confirms
that the protected `production` environment has required reviewers and no
environment-scoped secret visible to the current credential.

The current credential cannot inspect organization-level Actions secrets. It is
therefore unverified whether an organization secret with an equivalent purpose
exists or is shared with this repository. The workflow implementation must
require the exact `BRAIN_API_KEY_PEPPER_PRODUCTION` secret and fail closed when
it is absent. This scope does not claim that every possible GitHub secret store
has been inventoried.

## Required workflow

Add a production-only `workflow_dispatch` workflow modelled on
`ops-cors-allowed-origins.yml`. The implementation should expose a fixed action
choice of `inspect`, `enable`, or `disable`. It must not accept a host, env-file,
compose-project, command, pepper, or rate-limit input.

Fixed workflow boundaries:

| Setting            | Required value                 |
| ------------------ | ------------------------------ |
| GitHub environment | `production`                   |
| Concurrency group  | `promote-prod`                 |
| VM host            | repository secret `VM_HOST`    |
| SSH key            | repository secret `VM_SSH_KEY` |
| Remote directory   | `~/brain-core`                 |
| Environment file   | `.env.prod`                    |
| Compose project    | `brain-prod`                   |
| API base           | `https://api.brain.fi`         |
| API service        | `api` only                     |

### Secret prerequisite

Create an environment-specific protected secret named
`BRAIN_API_KEY_PEPPER_PRODUCTION` before the first enable run. Generate at least
32 random bytes from a cryptographically secure generator. The workflow may
transport it into `.env.prod`, but must never print it, pass it on a process
command line, persist it in a workflow artifact, or expose it in a plan.

This secret is durable key-verification material, not a routinely rotated
credential. `api_keys.hashed_secret` is derived from the plaintext key and the
pepper. Replacing the pepper immediately invalidates every issued key. Any
future rotation therefore requires a separate migration or an explicit
all-keys revocation plan.

Store the new secret in the protected `production` GitHub environment where
possible, not as a broadly available repository secret. Verify that both
required production reviewers can approve the workflow but cannot retrieve the
secret value from logs or artifacts.

### Inspect and preflight

Before any write, the workflow must:

1. Run under the protected `production` environment and serialize with
   `promote-prod`.
2. Establish SSH using only the fixed production secrets.
3. Run `scripts/ops/assert-true-production.sh` with
   `API_BASE=https://api.brain.fi` and `VM_ENV_FILE=.env.prod`. This proves the
   public health commit matches `brain-prod-api`, `NODE_ENV=production`, the
   local primary Postgres endpoint, and the expected database.
4. Require `.env.prod` to exist, be a regular file, and not be a symlink.
5. Report only whether each of the four API-key variable names is absent,
   present-empty, or present-nonempty. Never print values.
6. Read the running API container's parsed boolean for
   `BRAIN_API_KEY_AUTH_ENABLED` and whether the pepper is nonempty, returning
   booleans only.
7. Confirm `api_keys` migration `0017` is applied and the table has the expected
   tenant isolation policy. Use read-only queries and return counts or booleans,
   not digests or secrets.
8. Confirm Redis is healthy because the API-key rate limiter uses the production
   Redis dependency.
9. Confirm the selected production pepper secret is nonempty before creating a
   patch file.

`inspect` stops here. It performs no writes and no container recreation.

### Enable

After the inspect gates and a production approval:

1. Create a mode `0600` local patch containing the four fixed settings. Transfer
   it to a unique mode `0600` path on the VM.
2. On the VM, copy `.env.prod` to a dated mode-preserving backup such as
   `.env.prod.bak-api-key-<UTC timestamp>`.
3. Parse the environment file by exact variable name. Replace the last active
   occurrence, remove older active duplicates, preserve comments and unrelated
   settings, append missing keys, and atomically replace the original file in
   the same directory. Preserve ownership and mode.
4. Delete the local and remote plaintext patch in an unconditional cleanup
   handler. Do not upload either file as an artifact.
5. Run `scripts/check-required-compose-secrets.sh` against
   `docker-compose.prod.yml` and `.env.prod` before recreation.
6. If the guard fails, restore the backup atomically and stop without recreating
   any service.
7. Recreate only `api` with the existing Compose files, `--no-deps`,
   `--no-build`, and `--force-recreate`. Auth, worker, agents, surface-gateway,
   Postgres, Redis, and MinIO do not need recreation for this API-only setting.
8. Prove the API container is running the same commit as public `/health`, has
   `NODE_ENV=production`, has the parsed flag set to true, and sees a nonempty
   pepper. Report booleans only.
9. Run the acceptance sequence below. Any failure triggers the disable rollback
   procedure.

### Live acceptance sequence

Do not reuse `staging_api_key_acceptance.py` unchanged. It permanently creates a
tenant and labels its messages as staging. Add a production-specific wrapper or
generalize the script so it has an explicit production preflight and guaranteed
cleanup.

The acceptance run must use a unique disposable tenant, never the Northstar
presenter tenant or a customer tenant. It must:

1. Create the disposable tenant through the existing platform-authenticated
   production tenancy route.
2. Issue one `brain_sk_test_` key with only the currently approved commercial
   read scopes. This flag workflow must not request `raw:read` or `raw:write`;
   that scope-policy change is independent.
3. Call `GET /v1/ledger/accounts` with the key and receive 200.
4. Call one permitted audit or governance read route and receive 200.
5. Verify key-attributed request-meter usage appears for the exact key id.
6. Rotate the key, prove the old key receives `auth_invalid_key`, and prove the
   replacement key works.
7. Revoke the replacement key and prove it receives `auth_invalid_key`.
8. Delete the disposable tenant through the tenant deletion API, confirm the
   tenant row is gone, and retain only the intended immutable deletion audit
   history.

The workflow output may contain the disposable tenant id, key ids, HTTP status
codes, audit event counts, commit, and timestamps. It must never contain either
plaintext key or the pepper.

Rate-limit verification should be a separately approved canary or use a
dedicated low-limit test hook. Sending hundreds of production requests merely
to exhaust the default `600` request window is not an appropriate enablement
probe.

## Monitoring after enablement

For the first observation window, record:

- API restart count and health commit;
- rates of `auth_invalid_key`, `auth_scope_insufficient`, and `rate_limited`;
- key issue, rotate, revoke, and use audit counts;
- Redis errors from the API-key limiter;
- route 4xx and 5xx rates for the key lifecycle and commercial read endpoints;
- confirmation that no `brain_sk_live_` key or disallowed scope was issued as
  part of acceptance; and
- confirmation that key secrets and the pepper do not appear in logs or
  workflow artifacts.

An operator should explicitly close the observation window. A green health
endpoint alone is not sufficient.

## Rollback

Rollback disables authentication and lifecycle routes. It does not delete
`api_keys` rows, change tenant data, or rotate the pepper.

The production-only workflow's `disable` action must:

1. Run the same true-production and environment-file preflights.
2. Atomically set `BRAIN_API_KEY_AUTH_ENABLED=false` while preserving
   `BRAIN_API_KEY_PEPPER` unchanged for a later reviewed re-enable.
3. Run the required-secret guard.
4. Recreate only `api` using the current image.
5. Prove health and commit identity, confirm the parsed flag is false, and
   confirm an already revoked acceptance key remains rejected.

If the enabled API fails to boot, restore the dated `.env.prod` backup and
recreate only `api`. If the previous API container is still serving, do not
replace unrelated services. Capture redacted API logs, the health response,
workflow run id, backup filename, and rollback result.

Do not delete or blank the pepper during emergency disablement. Losing it makes
all existing keys permanently unverifiable. Do not use `docker compose down`,
`docker compose down -v`, Terraform, DNS changes, or an image rollback for a
flag-only rollback unless a separate application regression requires one.

## Separation from RFC 0007 changes

This operational decision exposes the currently implemented key lifecycle and
commercial read-key authentication surface. It must remain independently
reviewable from both RFC 0007 implementation workstreams:

- ordinary-signup demo seeding; and
- the conditional `brain_sk_test_` Raw-scope allowlist exception.

The enablement acceptance run uses only scopes already permitted on `main`.
Merging either RFC change must not automatically dispatch this workflow, and
dispatching this workflow must not imply approval of synthetic Raw access.

## Implementation checklist

### Done in this scope

- [x] Confirmed the VM reads the feature settings from host-managed `.env.prod`.
- [x] Confirmed no Terraform or infrastructure change is required.
- [x] Compared the production proposal with the staging VM and PR #582 guarded
      workflow patterns.
- [x] Identified the production pepper as a missing explicit workflow
      prerequisite in the visible repository and environment secret inventory.
- [x] Defined production identity, secret-presence, database, Redis, lifecycle,
      monitoring, and rollback gates.
- [x] Kept Container Apps and Azure staging work outside scope.

### Pending approval and implementation

- [ ] Approve the production-only workflow design and secret ownership.
- [ ] Create `BRAIN_API_KEY_PEPPER_PRODUCTION` in the protected production
      environment without exposing its value.
- [ ] Implement the fixed `inspect`, `enable`, and `disable` workflow actions.
- [ ] Implement the cleanup-safe production acceptance wrapper.
- [ ] Add workflow contract and acceptance-script regression tests.
- [ ] Review the production plan and rollback procedure.
- [ ] Dispatch `inspect` and review its redacted evidence.
- [ ] Make and record the independent go or no-go decision.
- [ ] Dispatch `enable` only after that decision.
- [ ] Complete the monitored observation window or dispatch `disable`.
