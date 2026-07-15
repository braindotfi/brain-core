# Tier 1 Policy Gating Follow-up

**Date:** 2026-07-15

**Branch:** `fix/tier-1-followup`

## Fixed

- A1: Production API boot now refuses to start an execution worker without the
  outbox `beforeDispatch` guard that rechecks creator-agent state immediately
  before dispatch.
- A2: `brain_privileged` is removed from blanket DML grants, limited to the
  deploy seed and verifier footprint, and explicitly revoked from
  `audit_events` INSERT.
- A3: Tenant deletion retains the BYPASSRLS erasure role but all DELETE SQL is
  generated through a checked helper that requires an exact tenant predicate.
- A4: Unused DELETE grants are removed from `brain_raw_worker` and
  `brain_ledger_projector`; `brain_canonical_projector` keeps only the verified
  `canonical_journal_line` DELETE used by journal-entry upsert.
- A5: API-owned tenant tables now have `services/api/migrations/0015_force_rls.sql`
  applying FORCE ROW LEVEL SECURITY to `tenants`, `wallet_identities`,
  `tenant_blob_purge_jobs`, `tenant_blob_purge_audit_outbox`, and
  `email_verifications`.
- A6: Operators can restore a halted agent through
  `POST /v1/agents/{agent_id}/restore`; the route only transitions
  `quarantined` to `active` and fails closed for every other state.

## Awaiting Decision

- B1: Fiat-rail autonomous execution cap. This changes live payment semantics
  and should be accepted as a policy decision before implementation.
- B2: Production confidence-floor linter escalation from warning to reject. The
  warning path can be promoted after policy authors confirm the minimum floor.
- B3: Rename one of the quarantine surfaces. This is a breaking API copy and
  route decision, so it is tracked as a proposal rather than merged here.
