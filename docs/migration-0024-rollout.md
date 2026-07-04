# Migration 0024 rollout notes (`bootstrap_missing_members`)

Status: applies to prod running v0.0.7 (`5e67f5b`) with DB migrated through `execution/0023`.

`services/execution/migrations/0024_bootstrap_missing_members.sql` (PR #218) is a pure,
idempotent data backfill: no schema changes, no new objects, no grants required. It seeds
one active admin member into every tenant that currently has **zero** member rows. Tenants
that already have members (e.g. the manually seeded golden tenant) are excluded entirely.

## Migration-only is a partial unblock

- **Tenants with an existing user or agent row** get a real admin whose `member.id` equals
  the earliest user id, which is that user's JWT principal. For these tenants `/v1/members`
  flips 403 to 200 and member CRUD works under the current prod code. If you are testing
  members logic against an existing tenant, the backfill alone clears you.
- **Tenants with no users and no agents** get only a placeholder admin
  (`user_bootstrap_<md5>`, `bootstrap+<tenant>@brain.invalid`) that matches no real JWT
  principal. This is by design; such tenants are not truly unblocked until a real admin is
  linked.
- **Code paths still gated on deploying `a1b8dd8`:**
  - Fresh provisioning (#218, `services/api/src/onboarding/bootstrap-member.ts`): until the
    code deploy, newly provisioned tenants keep landing with zero members and need another
    0024-style backfill.
  - Demo/agent session actor resolution (#219, session split + `principal_type=user` guard):
    agent-provisioned sessions cannot resolve an actor for approval/member workflows until
    the code deploy.

## Applying against prod

Run on the VM per the standard deploy runbook: `node tools/migrate/dist/cli.js status` (expect
only `execution/0024` pending), then `up`, then `status` again. Verify `/health`, an authed
`GET /v1/members` on a seeded tenant returns 200, and `42501=0` in api+worker logs. The
migration touches only the small control-plane tables (`tenants`, `users`, `agents`,
`members`) in one short transaction, with no locks on `audit_events`.

See also: `docs/contracts/members-attribution.md`.
