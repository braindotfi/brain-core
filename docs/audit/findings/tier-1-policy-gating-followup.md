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

## Group B Fixed

- B1: Fiat-rail approval floor is implemented. `wire` always requires a
  recorded human approval when policy allows. `ach_outbound`, `ach_inbound`,
  and `card_payment` can execute autonomously only when the matched signed
  policy rule carries a covering per-action cap:
  `ach_autonomous_max_amount` or `card_autonomous_max_amount`.
- B2: Policy activation now runs the production confidence-floor lint. Missing
  `agent.confidence.gte` or a bound `<= 0.5` returns a structured warning by
  default. `BRAIN_POLICY_CONFIDENCE_FLOOR_REJECT=true` escalates the same
  finding to an activation reject.
- B3: The H-09 contribution intake surface is renamed from contribution
  quarantine to contribution hold. The breaking route is now
  `POST /v1/agents/{agent_id}/contribution-hold/release`; the DB column is
  `contribution_hold_cleared_at`. Agent lifecycle state `quarantined` and the
  halt or restore routes remain unchanged.
