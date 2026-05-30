# Audit: Agent Router & Routing Pipeline

**Audited:** 2026-05-26
**Files examined:**

- `services/agent-router/src/router.ts`
- `services/agent-router/src/types.ts`
- `services/agent-router/src/worker.ts`
- `services/agent-router/src/agent-run-service.ts`
- `services/agent-router/src/agent-api.ts`
- `services/agent-router/src/route.ts`
- `services/agent-router/src/action-resolver.ts`
- `services/agent-router/src/intent-classifier.ts`
- `services/agent-router/src/evidence-gatherer.ts`
- `services/agent-router/src/promotion.ts`
- `services/agent-router/src/promotion-config.ts`
- `services/internal-agents/src/registry.ts`
- `services/internal-agents/src/handler.ts`
- `services/internal-agents/src/payment/handler.ts`
- `services/internal-agents/src/payment/definition.ts`
- `services/internal-agents/src/collections/handler.ts`
- `services/internal-agents/src/reconciliation/handler.ts`
- `services/internal-agents/src/personal_budget/handler.ts`
- `shared/src/events/triggers.ts`
- `services/api/src/main.ts` (lines 1043–1193, 1320–1373, 1611–1627)
- `services/execution/src/agent-runs.ts`
- `services/execution/migrations/0007_agent_routing_decisions.sql`
- `services/execution/migrations/0008_agent_runs.sql`

**Commands run:**

```
pnpm --filter @brain/agent-router run typecheck
pnpm --filter @brain/agent-router run test
pnpm --filter @brain/internal-agents run typecheck
pnpm --filter @brain/internal-agents run test
grep -rn "publishDomainEvent|emitDomainEvent|pg_notify" services/ --include="*.ts"
grep -rn "isActionAllowed|allowedActionsFor|H-23" services/api/src/main.ts
grep -n "LIVE_AGENTS|liveAgents" services/agent-router/src/promotion-config.ts
grep -rn "agent_runs|insertRoutingDecision|insertAgentRun" services/execution/src/
```

---

## 1. Scope

This report covers:

- `@brain/agent-router`. The routing engine, `AgentRunService`, `POST /agents/route`, `POST /agents/run`, and the BullMQ `brain.agent.route` queue worker
- `@brain/internal-agents`. The 19 first-party agent catalog (definitions + handlers)
- The domain-event vocabulary and producer-consumer wiring in `shared/src/events/`
- The graduated money-movement promotion policy (`promotion-config.ts`)
- Boot composition of all the above in `services/api/src/main.ts`

Out of scope: the Python reconciliation agent (covered in `agents/python.md`); MCP surface (covered in `mcp/runtime.md`); execution-layer state machine (covered in `services/execution.md`).

---

## 2. Intended Architecture

Per `CLAUDE.md` and `types.ts`:

> The router NEVER executes. The selected agent proposes through the existing `/v1/agents/{id}/propose` path, which runs Policy and the §6 gate.

The design is:

1. **AgentRouter**. Receives an event name or free-form intent; filters the catalog by capability match → tenant scope grants → scores candidates (trigger match × intent match × evidence completeness × reputation × cost × category alignment); returns a `RoutingDecision` with `selected_agent_id`, `confidence`, `execution_mode`, `fallback_agent_ids`.
2. **ActionResolver**. Given the selected agent's definition + handler actions, resolves the specific action using a four-step priority: (1) explicit context key, (2) `event_action_map`, (3) `intent_action_map` (classifier), (4) `default_action`. Never silently falls back to `handler.actions[0]`.
3. **AgentRunService**. Orchestrates the full `POST /agents/run` pipeline: route → resolve action → gather evidence → `handler.build()` → shadow gate (Phase 1a/1b: financial proposals from non-promoted agents terminate as `shadow_completed`) → `proposeAction()` → persist run + routing-decision rows.
4. **createAgentRouteWorker**. BullMQ consumer of `brain.agent.route` queue; calls `routeAndPropose()` for event-driven (async) routing.
5. **internalAgentCatalog / internalAgentHandlers**. 19 first-party agents. `build()` is pure (no I/O). Financial proposals return `channel: "payment_intent"` feeding `IPaymentIntentService.create`. Non-financial proposals return `channel: "agent"` feeding `IAgentService.propose`.
6. **StaticPromotionPolicy / LIVE_AGENTS**. Config-driven allowlist governing which agents may move money and on which rails. Default: all shadowed.
7. **Domain event bus**. `shared/src/events/triggers.ts` defines 36 vocabulary entries; producers call `emitDomainEvent(enqueue, { tenantId, event, context })` which enqueues to `brain.agent.route`.

---

## 3. Actual Implementation

### AgentRouter. Fully implemented

`router.ts:74–146` implements the described pipeline exactly:

- `catalog()` → `filter(enabled_by_default)` → parallel `matches()` calls → `getScopedCapabilities` filter → parallel scoring → sort → `resolveExecutionMode()` → audit emit before and after
- Scoring weights: `confidence = 0.6 * matchQuality + 0.25 * bundle.completeness + 0.15 * reputation`; category mismatch is a `-0.2` downgrade (never reject)
- `noMatch()` covers both `no_match` and `unscoped` terminal paths with audit events

### ActionResolver. Fully implemented

`action-resolver.ts:61–123` implements all four resolution steps in priority order. Importantly:

- Explicit action check: validates against `offered` set, then against `isActionAllowed` hook if present
- `event_action_map` match uses the definition's map (e.g. `payment` maps `bill.due_soon → propose_payment`)
- `intent_action_map` uses the classifier (score ≥ threshold per rule, picks best)
- `default_action` is genuinely opt-in. Money-movers explicitly have no `default_action` (safety: requires event or intent)
- Returns `missing_action` (never a silent fallback)

### AgentRunService. Fully implemented

`agent-run-service.ts:110–344` implements the full shadow-aware orchestration:

- Records `agent_routing_decisions` row via the injected `AgentRunStore` (DB-backed at boot)
- Shadow gate: `isShadowed(agentId)` → terminates financial proposals as `shadow_completed`
- Graduated rollout (Phase 1b): `checkRail(agentId, actionType)` provides per-rail restriction even for live agents
- Non-financial proposals and reconciliation (Python agent override) unaffected by shadow
- Records `agent_runs` row at every terminal state (no_match, unscoped, missing_handler, missing_action, shadow_completed, proposal_created)

### createAgentRouteWorker. Fully implemented

`worker.ts:142–166` wraps `routeAndPropose()` (the same pipeline, minus run persistence) in a BullMQ worker on `QUEUE_NAMES.agentRoute` (`"brain.agent.route"`). Wired at boot (`main.ts:1616`), gracefully shut down in `shutdown()` (`main.ts:1641`).

### internalAgentCatalog. 19 agents, all with handlers

`registry.ts:52–113` registers 19 agents. All 19 have a paired handler. Breakdown:

| Category                           | Agents                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Business. Financial (money-mover)  | payment, treasury, savings, debt_optimization                                                                 |
| Business. Non-financial (advisory) | collections, reconciliation, subscription, vendor_risk, cash_forecast, dispute, compliance, revenue_intel     |
| Consumer. Non-financial (advisory) | personal_budget, bill_management, fraud_anomaly, tax_prep, travel_finance, financial_health, purchase_advisor |

All non-financial handlers call the `agentProposal()` helper. Non-financial advisory proposals with no I/O in `build()`. The `payment` handler is the reference money-mover: it detects `FINANCIAL_ACTIONS`, shapes a `CreatePaymentIntentInput`, and returns `channel: "payment_intent"`.

### Promotion policy. Payment agent live, all others shadowed

`promotion-config.ts:22–26`:

```ts
export const LIVE_AGENTS: PromotionConfig = {
  liveAgents: {
    payment: ["ach", "onchain"],
  },
};
```

The `payment` agent is promoted to live for ACH and on-chain rails. All other 18 agents remain shadowed. The `StaticPromotionPolicy` at boot (`main.ts:1170`) consumes this config; `isShadowed()` returns `false` only for `payment`.

**Implication:** financial proposals from `payment` go through `proposeAction()` → `IPaymentIntentService.create()` → the §6 gate → the durable outbox worker → the real Plaid or on-chain rail. This is a live money-movement path with the payment agent already promoted.

### Intent classifier

Default (and current production): `RulesIntentClassifier`. Token-overlap scoring, deterministic. Embedding classifier (`EmbeddingIntentClassifier`) is behind `AGENT_INTENT_CLASSIFIER=embedding` feature flag; when active it uses the same `embed` function as Wiki, with the rules classifier as a live fallback.

### Evidence gatherer

`main.ts:1048`: `agentEvidence = new StaticEvidenceGatherer()`. A fixed empty set. No Wiki citations, no Ledger references are gathered. All agents resolve to `evidence_score: 0`, which drives `execution_mode: notify_only` for any agent that declares `required_evidence`. The `payment` agent declares `required_evidence: ["invoice", "counterparty", "payment_destination"]`; with zero evidence, its `completeness = 0`, meaning `confidence ≤ 0.6 * matchQuality + 0.15 * reputation`. Likely below the `minimum_confidence: 0.85` threshold for money-moving. The effect: even the promoted payment agent rarely reaches `autonomy` mode; it routes to `notify_only` without actual evidence wiring.

### Domain event producers. INTEGRATION MARKERS ONLY

`emitDomainEvent` is defined in `shared/src/events/triggers.ts:74`. Searching for actual call sites across all services:

- `services/execution/src/payment-intents/PaymentIntentService.ts:323-326`. Comment: "INTEGRATION POINT (agent-router, Phase 1): a `payment.failed` domain event would be emitted … Wiring the enqueue dep into this service is a follow-up."
- `services/ledger/src/reconciliation/ReconciliationService.ts:112-115`. Comment: "INTEGRATION POINT (agent-router, Phase 1): a `reconciliation.candidate_found` event would be emitted … Wiring the enqueue dep is a follow-up."

**No production code calls `emitDomainEvent`.** The 36-event vocabulary, the BullMQ queue, and the worker are all in place, but zero events are ever enqueued from production service paths. The `brain.agent.route` queue will remain perpetually idle unless `POST /agents/events` (HTTP enqueue path) is called directly or the integration markers are wired.

### H-23 action allowlist. Still unwired

`main.ts:1092`:

```ts
const actionResolver = new ActionResolver({ classifier: agentClassifier });
```

The `isActionAllowed` hook is `undefined`. The comment explicitly acknowledges: "Until wired, an explicit action is accepted if the agent offers it (pre-H-23 behavior)." The signed policy's per-agent action restrictions (R-22) remain unenforced at the routing layer.

### getScopedCapabilities. Hardcoded full set

`main.ts:1052`: `internalAgentCapabilities = new Set(internalAgentCatalog.flatMap((d) => d.capabilities))`. All capabilities are marked as scoped for every tenant. No actual on-chain `ScopeAttestation` grants are checked. The scope filter in the router is effectively a no-op: every tenant sees every agent.

### getTenantCategory. Hardcoded "business"

`main.ts:1078` and `main.ts:1187`: both `AgentRouter.getTenantCategory` and `AgentRunService.getTenantCategory` always return `"business"`. Consumer agents (personal_budget, bill_management, etc.) are registered in the catalog but will always receive the `CATEGORY_MISMATCH_PENALTY = -0.2` downgrade, making them structurally less likely to be selected even for a consumer-facing tenant.

---

## 4. Runtime Validation

**Typecheck. Both workspaces pass:**

```
pnpm --filter @brain/agent-router run typecheck   → 0 errors
pnpm --filter @brain/internal-agents run typecheck → 0 errors
```

**Tests. All pass:**

```
@brain/agent-router:   18 test files, 166 tests passed
@brain/internal-agents: 11 test files, 135 tests passed
Total: 301 tests
```

Notable test files:

- `business-routing.test.ts`: 59 tests. Covers trigger matching, intent matching, scope filtering, category penalties, evidence scoring, `no_match`/`unscoped` paths
- `adversarial.test.ts`: 3 tests. Injection attempts in intent strings
- `action-resolver.test.ts`: 13 tests. All four resolution paths plus `missing_action`
- `agent-run-service.test.ts`: 4 tests. Shadow gate, `proposal_created`, `missing_handler`, routing decisions persisted
- `all-handlers.test.ts` (internal-agents): 77 tests. Every agent's `build()` verified for both financial and non-financial outputs
- `business-agents.test.ts`: 19 tests. Business agent definitions (triggers, capabilities, required_evidence)

**Domain event producer grep:**

```
grep -rn "emitDomainEvent" services/ --include="*.ts" (excl. tests)
→ services/execution/src/payment-intents/PaymentIntentService.ts:325 (comment)
→ services/ledger/src/reconciliation/ReconciliationService.ts:114 (comment)
```

Zero actual `emitDomainEvent(...)` call sites found in service code.

**Promotion config:**

```
LIVE_AGENTS = { liveAgents: { payment: ["ach", "onchain"] } }
```

All other 18 agents shadowed.

**Evidence gatherer at boot:**

```
agentEvidence = new StaticEvidenceGatherer()  // empty set, main.ts:1048
```

TODO comment present; no wiring to Wiki or Ledger evidence.

---

## 5. Functional Status

**Mostly Working** (routing engine and catalog) / **Partial** (end-to-end pipeline)

The routing engine itself. Scoring, action resolution, shadow gate, run persistence, BullMQ worker. Is correctly implemented and fully tested. The catalog has 19 real agents with correct handler/definition pairs. What is missing is the activation layer: no domain events fire from service code, evidence is empty so confidence is structurally suppressed, scope and category checks are hardcoded, and H-23 action allowlists are not enforced.

The HTTP `POST /agents/run` path works: a caller can POST a free-form intent and receive a `RoutingDecision` with a proposal created. The async event-driven path (`POST /agents/events` → BullMQ → worker) is structurally ready but idle because no producers emit events.

---

## 6. Architectural Violations

**Layer boundary: evidence gatherer reads empty (deliberate deferral, not a violation)**
The `EvidenceProviders` interface in `evidence-gatherer.ts` is designed to inject Wiki and Ledger reads without the router depending on those packages directly. The current `StaticEvidenceGatherer()` is an intentional Phase 1 placeholder acknowledged in `main.ts:1044-1047`. Not a boundary violation. It is a correctly-abstracted seam left unwired.

**Category hardcode creates consumer-agent dead zone**
`getTenantCategory: () => "business"` at two call sites means all 9 consumer agents always receive the penalty. This is not a layer violation but an architectural gap: consumer-targeted agents exist in the catalog, are tested, and are registered at boot, but they are structurally deprioritized for every tenant regardless of their actual type. The gap is acknowledged in a TODO comment at `main.ts:1073`.

**Scope attestation bypass**
On-chain `ScopeAttestation` grants (per CLAUDE.md: "Capabilities the tenant has scoped (on-chain ScopeAttestation grants)") are not checked at all. Every tenant can route to every agent. The `getScopedCapabilities` interface correctly accepts a per-tenant lookup, but the boot binding makes it tenant-blind. This is a planned feature (Phase 3), not a production regression. Internal agents are `enabled_by_default: true` by design. But it means the scope-filtering step in the router has no security effect today.

**`isActionAllowed` gap (R-22 reconfirmed)**
The signed-policy per-agent action allowlist defined in `@brain/policy` is bypassed. An external caller can pass any `requested_action` that the agent offers, even if the tenant's active policy prohibits it. The `ActionResolver` is designed to enforce this via the injected hook; the hook is absent.

---

## 7. Missing Pieces

1. **Domain event producers**. Zero `emitDomainEvent()` call sites in production code. The `brain.agent.route` queue is perpetually idle. The 36 vocabulary entries and the worker are fully ready; the integration markers at `PaymentIntentService.reject()` and `ReconciliationService.runMatchers()` need to become real calls.

2. **Evidence wiring**. `ServiceEvidenceGatherer` with Wiki citations and Ledger references is designed but not instantiated. All agents score zero evidence completeness, suppressing `execution_mode` to `notify_only` for most situations. **Directly affects the payment agent:** it declares `required_evidence: ["invoice", "counterparty", "payment_destination"]`; without this evidence, the gate check for evidence presence (§6 check 11) will fail for autonomously-triggered payment proposals.

3. **Per-tenant scope resolution**. On-chain `ScopeAttestation` grant lookup not wired. Every tenant is implicitly granted all agent capabilities.

4. **Per-tenant category resolution**. `getTenantCategory` hardcoded to `"business"`. Consumer agents exist in the catalog but are structurally penalized for all tenants.

5. **H-23 action allowlist injection**. `isActionAllowed` not passed to `ActionResolver`. Signed-policy per-agent action restrictions are defined but not enforced at the routing layer.

6. **`routeAndPropose` vs `AgentRunService`**. The BullMQ worker uses `routeAndPropose()` (no run persistence), while the HTTP path uses `AgentRunService` (full run persistence). Event-driven routing does not record `agent_runs` or `agent_routing_decisions` rows. An event-triggered route-and-propose leaves no audit trail beyond the routing audit event emitted by `AgentRouter`.

---

## 8. Evidence

**Catalog has 19 real agents with real handlers:**

```
services/internal-agents/src/registry.ts:52–113
internalAgentCatalog: 19 entries
internalAgentHandlers: 19 entries (matching keys)
```

**Payment agent is promoted live:**

```
services/agent-router/src/promotion-config.ts:22–26
LIVE_AGENTS = { liveAgents: { payment: ["ach", "onchain"] } }
```

`AgentRunService.isShadowed("payment")` returns `false`. Financial proposals from the payment agent reach `proposeAction()` → `IPaymentIntentService.create()`.

**Evidence gatherer is empty at boot:**

```
services/api/src/main.ts:1048
const agentEvidence = new StaticEvidenceGatherer();
// TODO(phase-1): wire Wiki citations + Ledger references
```

**Domain event producers are comments, not calls:**

```
services/execution/src/payment-intents/PaymentIntentService.ts:323–326
// INTEGRATION POINT (agent-router, Phase 1): a failed/rejected payment is
// where a `payment.failed` domain event would be emitted via @brain/shared
// `emitDomainEvent`, so the router can route to the collections agent.
// Wiring the enqueue dep into this service is a follow-up.
```

**H-23 gap. `isActionAllowed` absent:**

```
services/api/src/main.ts:1092
const actionResolver = new ActionResolver({ classifier: agentClassifier });
// comment: "Until wired, an explicit action is accepted if the agent offers it"
```

**Worker persistence gap. `routeAndPropose` vs `AgentRunService`:**

```
services/api/src/main.ts:1616  → createAgentRouteWorker → calls routeAndPropose (worker.ts)
services/api/src/main.ts:1179  → AgentRunService (HTTP path) → calls store.recordRoutingDecision + store.recordRun
```

`routeAndPropose` has no `store` parameter; the BullMQ worker path records no DB rows.

**Scoring formula (router.ts:178):**

```ts
const confidence = clamp01(0.6 * matchQuality + 0.25 * bundle.completeness + 0.15 * reputation);
```

With `bundle.completeness = 0` (no evidence) and `reputation = 0.5` (default neutral), max confidence from a trigger match is `0.6 * 1 + 0.25 * 0 + 0.15 * 0.5 = 0.675`. Below the payment agent's `minimum_confidence: 0.85`. So even promoted-live payment agent proposals triggered by a domain event will resolve to `notify_only`, not `autonomy`.

**BullMQ shutdown wiring confirmed:**

```
services/api/src/main.ts:1641–1644
await agentRouteWorker.close()  // graceful drain
```

---

## 9. Confidence Level

**High** for what the code does; **Medium** for end-to-end behavior.

The router, action resolver, agent catalog, shadow gate, and run persistence logic are all read in full. The boot wiring is traced in detail. The 301 test results are observed directly. The gaps (no event producers, empty evidence, hardcoded scope/category, unwired H-23) are confirmed via grep. Not inferred.

The "Medium" qualifier applies only to runtime: without a running DB and live events, we cannot observe routing decisions persisted or the payment agent actually proposing through the §6 gate. All structural evidence points to the code being correct; the operational gaps are all confirmed-missing wiring rather than broken logic.

---

## 10. Production Readiness

**Score: 6/10. Mostly Working (routing engine), Partial (end-to-end pipeline)**

| Dimension                   | Status                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| Routing engine correctness  | Ready (evidence-backed scoring, deterministic classifier, audited) |
| Internal agent catalog      | Ready (19 agents, 135 handler tests, correct proposal shaping)     |
| Shadow gate                 | Ready (all 18 non-payment agents shadowed by default)              |
| Run persistence (HTTP path) | Ready (routing_decisions + agent_runs tables, RLS-covered)         |
| Domain event producers      | Not wired. Queue perpetually idle (R-25)                           |
| Evidence gathering          | Not wired. Zero evidence, confidence suppressed (R-26)             |
| Per-tenant scope grants     | Not wired. All tenants have all capabilities                       |
| Per-tenant category         | Hardcoded "business". Consumer agents deprioritized                |
| H-23 action allowlist       | Not wired. Explicit actions bypass policy restrictions (R-22)      |
| Worker run persistence      | Missing. Event-driven path leaves no DB audit trail (R-27)         |
| Payment agent confidence    | Structurally below `minimum_confidence` without evidence wiring    |

**Blockers before production (agent-router specifically):**

1. **R-25. Domain event producers unwired.** The entire async routing path depends on services emitting events. Without this, the routing pipeline is HTTP-only and manual.
2. **R-26. Evidence gatherer unwired.** The payment agent's required evidence is never gathered, meaning §6 gate checks for evidence presence will fail for any autonomously-triggered payment proposal. Even promoted agents cannot move money autonomously without this.
3. **R-27. Worker path missing run persistence.** Event-driven routing produces no `agent_runs` or `agent_routing_decisions` DB rows. The audit trail is incomplete for the async path.

**Non-blocking gaps (acceptable tech debt for current phase):**

- Per-tenant scope and category resolution (Phase 3 gates)
- H-23 injection (Medium risk, not exploitable without active adversarial clients)
- Embedding classifier is opt-in and gracefully falls back

---

## 11. Refactor Priority

**High**. The routing engine is solid, but the three wiring gaps (event producers, evidence gatherer, worker persistence) must be resolved before the system can operate as designed. The promoted payment agent is live on ACH and on-chain rails but can only be triggered via direct HTTP, not autonomously via domain events. Evidence absence means the confidence threshold is never reached for autonomy mode.

The fixes are all injection/wiring changes, not structural rewrites:

1. Add `enqueue` dep to `PaymentIntentService` and `ReconciliationService`; replace the integration-marker comments with real `emitDomainEvent()` calls.
2. Replace `StaticEvidenceGatherer` with `ServiceEvidenceGatherer` wired to the existing `wikiService` citation method and a `LedgerService` reference query.
3. Add a `store` parameter to `routeAndPropose` (worker path) or use `AgentRunService.run()` from the worker. Eliminating the two-code-path divergence.
4. Inject `isActionAllowed` into `ActionResolver` at `main.ts:1092` using per-request policy lookup.
