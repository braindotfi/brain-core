# Commercial shadow operator contract

## Scope

`ops-commercial-shadow.yml` is the only supported production lifecycle control
for RobotMoney Internal Commercial Shadow 2026-10. It exposes fixed
`inspect`, `start`, `pause`, `stop`, and `complete` actions. Every dispatch must
name the exact deployed SHA, supply an operator reason, pass the protected
production environment review, and use the action's exact confirmation string.
There is no tenant-id input.

`inspect` is read-only. It does not change environment files, create a tenant,
or recreate a service. The other actions append immutable transition evidence.

## Start boundary

Initial `start` generates a fresh tenant id inside the operator. The database
function rejects every protected tenant id and provisions all tenant-bound state
in one transaction:

- a production tenant with `data_profile=internal_commercial_shadow_v1` and
  `access_stage=production`,
- one bootstrap admin and one active default policy,
- one active RobotMoney entity,
- the exact `robotmoney_growth_v1` commercial entitlement with no price or
  billing-account link,
- the immutable `internal_commercial_shadow` billing exclusion,
- one BFF service agent and one `brain_ak_live_*` credential with the fixed
  `bff_service_v1` profile,
- one `brain_sk_live_*` credential with only `ledger:read`, `audit:read`, and
  `governance:read`, and
- an immutable tenant-bound contract containing 25,000 API units and 2,500 MCP
  units.

The function repeats provenance, entitlement, credential, scheduler, protected
tenant, and zero-billing checks after provisioning. Only after they all pass
does it obtain `clock_timestamp()` and insert `commercial_shadow_periods.started_at`.
Workflow dispatch time is not evidence of the start time.

Plaintext credentials never enter SQL or workflow output. The operator sends
only keyed digests to Postgres and persists the one-time plaintext bundle in the
VM's `.commercial-shadow-secrets/credentials.json`, with directory mode 0700
and file mode 0600. A persistence failure immediately pauses the period.

## Scheduler health

Phase 4 owns `brain-commercial-shadow-daily.timer` and the heartbeat writer.
`start` cannot pass until all of the following are true:

1. The systemd timer is installed, enabled, active, and has a next firing time.
2. The database has a `live` heartbeat for
   `commercial_shadow_daily_v1` in `ready` state.
3. The heartbeat reports the exact approved and deployed SHA.
4. The heartbeat is no more than 15 minutes old.
5. Its next run is in the future and no more than 26 hours away.

This is a readiness heartbeat, not a synthetic claim made by Phase 3. Until the
Phase 4 installation performs its self-test and writes that row, `start` fails
closed.

## Lifecycle semantics

`pause` changes a running period to paused. The API runtime gate is disabled,
and Phase 4 must treat any state other than running as a hard no-work result.
Calling `start` on that same paused period performs a resume. It never changes
the original `started_at`.

`stop` is terminal. It disables the runtime gate and revokes both scoped
credentials. `pause` and `stop` remain available even if a billing invariant is
found broken, so an operator can always halt work. No completed observation may
be inferred from a stopped period.

`complete` is terminal and fails closed unless at least 30 days have elapsed,
there are 30 distinct UTC observation dates with complete API and MCP evidence,
there are no API or MCP reconciliation mismatch markers, enforcement remained
false, and the zero-billing invariant still holds. Completion disables the
runtime gate and revokes both scoped credentials.

If API environment activation or recreation fails after a `start` transaction,
the workflow restores the prior environment files, recreates the prior API
state, and records an automatic pause. A failed pause, stop, or complete runtime
recreation remains domain-safe because the database state already prevents
shadow work from being considered running.
