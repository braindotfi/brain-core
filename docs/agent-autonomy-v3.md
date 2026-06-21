# Agent Autonomy v3

Production hardening of the 19-agent internal library (8 business + 8 consumer + 3 agnostic) for autonomous execution. Internal and external agents share the same registry, ScopeAttestation, propose path, and §6 gate. Provenance is a metadata field, never a separate code path.

**Safety posture:** money-movers are **shadowed by default**. A financial proposal from an un-promoted agent terminates as `shadow_completed` and moves no money. Going live is a deliberate, per-agent promotion (`StaticPromotionPolicy`) gated by strict caps + an allowlisted rail. No agent in this build moves money until an operator promotes it.

## Non-negotiable invariants (unchanged)

Agents propose; the §6 gate is the only execution path. Policy is signed (EIP-712). One evaluator (live + dry-run share the same gate code). Risk tier gates `execute`. Policy never reads Wiki. Every material state change emits an audit event. Idempotency at two layers. Provenance on every Ledger row. PII redaction at the reasoning-trace boundary.

## Phase 1a. Foundations (shadow mode)

- **ActionResolver** picks the action within a selected agent: explicit `requested_action` → `event_action_map` → `intent_action_map` → opt-in `default_action`. Never silently falls back to `actions[0]`; an unresolved action persists as `missing_action`. Money-movers/high-risk agents declare **no** `default_action`.
- **Weighted evidence**. `EvidenceRef` + weighted `required_evidence`; `scoreEvidence` yields `evidence_score` (present-but-stale at 0.5×), `missing_required_evidence`, `critical_missing`.
- **Run persistence + PII redaction**. Six RLS tables (`agent_runs`, `agent_reasoning_traces`, `agent_routing_decisions`, `agent_run_steps`, `agent_evidence_refs`, `agent_idempotency_keys`); raw reasoning blobs are field-level redacted per `schemas/redaction-policies/agent-trace-v1.json` and gated behind `audit:incident_investigation`.
- **Two-layer idempotency**. Event layer (`agent_idempotency_keys`, day-bucketed) blocks duplicate runs; proposal layer (unique index on ledger `payment_intents` + execution `proposals`) blocks duplicate proposals → `409 agent_proposal_duplicate`.
- **§6 gate dry-run**. `runPreExecutionGate({ dryRun })` runs all 16 checks against the same Ledger state but persists nothing and emits no audit; trace cached 60s.
- **Unified `/v1/agents/*` API**. List/get, route, run, events, runs, runs/{id}/why, routing-decisions.

## Phase 1b. Execution preconditions

- **Balance reservations** (`ledger_reservations`). Gate check #8 subtracts active reservations so parallel money-movers cannot double-spend. The live `execute()` handoff locks the source account, locks the latest balance snapshot, rechecks `available_balance - active_reservations >= amount`, then creates the reservation atomically with `approved -> dispatching` and outbox enqueue; the worker consumes it on `executed` or releases it on deterministic rail failure.
- **Aggregate spend envelopes** (`policy_spend_counters`). DSL `agent.spend_in_window` / `agent.tx_count_in_window`, evaluated against tumbling-window counters.
- **Kill-switch**. PaymentIntent `paused` state + `/pause` `/resume` (re-runs the live gate) `/halt` (quarantine) `/halt-category`; rail dispatcher aborts on `paused`. On-chain: `BrainSmartAccount.pauseSessionKey` (disable, preserve state) vs `revokeSessionKey` (permanent).
- **`resolveFinalExecutionMode`**. One resolver applying every hard constraint in order (behaviorHash mismatch → reject; dry-run reject; `critical_missing`; high-risk caps at confirm; risky counterparty ≥ confirm; tenant + agent authority caps; `execute` only when fully eligible).
- **Signed DSL extensions**. `agent.id`, `tenant.category`, `action.in/not_in`, `agent.behaviorHash`, the window primitives, and `approval_required_above`.
- **20 policy templates** + **graduated promotion** (`StaticPromotionPolicy`: per-agent live flag + rail allowlist; default all-shadowed).

## Phase 2. Observability + behavior pinning

- **Structured reasons + `/why`**. Multi-factor `agent_runs.reason`; `/why` returns reason + (redacted) trace + gate trace + rail receipt.
- **behaviorHash pinning**. `keccak256(model_id, model_version, prompt_template_hash, tool_manifest_hash)` registered on-chain; gate **check 1.5** rejects a runtime mismatch; `updateBehaviorHash` re-attests.
- **Typed rail receipts**. `ach`/`wire`/`erp`/`onchain` schemas; the audit-after step refuses to commit an invalid receipt; `/replay-investigation` returns the forensic bundle.
- **19-agent payload contract** (`AGENT_PAYLOAD_REQUIRED_FIELDS` + `validateAgentPayload`).
- **Reconciliation advisory locks**. One reconciliation run per tenant across replicas.
- **High-risk treatment**. `agent_findings` + `agent_finding_overrides`; versioned finding-rule catalogs (vendor_risk, compliance).
- **Counterparty-facing**. Approved `message_templates` in the signed policy doc; `renderApprovedMessage` blocks free-form / unapproved variables.

## Phase 3. Defensive depth

- **Adversarial test suite**. Intent injection, action injection, counterparty SQL/prompt injection (opaque), Wiki-as-truth, envelope race, LLM-nondeterminism dedup, halt race (plus the gate suite's reservation + behaviorHash + evidence fixtures).
- **Agent-to-agent sagas**. `runSaga` runs forward; on failure compensates completed steps in reverse, each compensation emitting its own audit event.
- **Per-task session keys**. `derivePerTaskSessionKey` bounds a one-time child key to the exact counterparty, exact amount, and a ~10-minute TTL.

## Known seams (follow-ups)

- Money-mover go-live is a deliberate `StaticPromotionPolicy` change (default all-shadowed).
- Spend-counter utilization metrics and the nightly reservation sweep activate at promotion time.
- High-risk finding emission from the run path + the override HTTP endpoint; counterparty handler-boundary enforcement + recipient-from-Ledger + escalation cap; saga row persistence; per-task on-chain grant/revoke orchestration.
- Foundry tests for `pauseSessionKey` + the registry `behaviorHash` run in CI (forge not run locally).
- `Brain_MVP_Architecture.md` → v0.4 (Appendix A) is a separate PR.
