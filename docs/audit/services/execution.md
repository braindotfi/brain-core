# Audit: Execution Service (`@brain/execution`)

**Audited:** 2026-05-26
**Files examined:**
- `services/execution/src/payment-intents/PaymentIntentService.ts`
- `services/execution/src/payment-intents/state-machine.ts`
- `services/execution/src/payment-intents/PaymentIntentService.execute.test.ts`
- `services/execution/src/outbox/OutboxService.ts`
- `services/execution/src/outbox/worker.ts`
- `services/execution/src/outbox/OutboxService.test.ts`
- `services/execution/src/outbox/worker.test.ts`
- `services/execution/src/approvals/ApprovalService.ts`
- `services/execution/src/approvals/ApprovalService.test.ts`
- `services/execution/src/sagas.ts`
- `services/execution/src/sagas.test.ts`
- `services/execution/src/rails/stubs.ts`
- `services/execution/src/rails/ach-plaid.ts`
- `services/execution/src/rails/onchain-base.ts`
- `services/execution/migrations/0016_agent_action_sagas.sql`
- `services/execution/migrations/0017_execution_outbox.sql`
- `services/execution/migrations/0019_force_rls.sql`
- `services/api/src/main.ts` (lines 860–972, 1283–1309)

**Commands run:**
- `pnpm --filter @brain/execution run typecheck`
- `pnpm --filter @brain/execution run test`
- `grep -rn "runSaga|SagaStep" services/ --include="*.ts" | grep -v test | grep -v sagas.ts`
- `grep -rn "agent_action_sagas|agent_saga_steps" services/ --include="*.ts"`
- `grep -rn "applyPlaidTransferEvent|TRANSFER_EVENTS_UPDATE" services/ --include="*.ts"`
- `grep -n "outbox|PaymentIntentService|resolveTenantFlags|piService" services/api/src/main.ts`

---

## 1. Scope

This report covers:
- `PaymentIntentService`: full lifecycle from create through the §6 gate to the outbox hand-off, plus callbacks from the outbox worker (`completeExecution`, `failExecution`).
- `OutboxService` + `worker.ts`: the durable transactional-outbox pattern (H-04), claim/dispatch/settle/reclaim cycle.
- `ApprovalService`: quorum logic, P0.4 hardening (revoked signer, cross-tenant, duplicate, policy-version staleness).
- `runSaga` executor: forward + compensation logic and whether it is called in production.
- Rail implementations: `AchPlaidRail`, `OnchainBaseRail`, `defaultRails()` stub registry.
- State machine: the 9-state `PaymentIntentState` diagram.
- Migrations 0016–0020 in `services/execution/`.

Not covered: the legacy v0.2 `/execution/*` routes (covered by `services/api.md`), the gate itself (`shared/src/gate/` — already audited indirectly), and per-rail live integration (Plaid sandbox, anvil — deferred per CLAUDE.md).

---

## 2. Intended Architecture

Per CLAUDE.md and the codebase comments:

- `PaymentIntentService` is the only path that drives a PaymentIntent to `executed`. The §6 gate-bypass lint (`scripts/check-gate-bypass.mjs`) enforces no rail dispatch or `executed` transition may occur outside this service.
- H-04 (durable outbox): `execute()` no longer dispatches rails synchronously. It atomically enqueues an `execution_outbox` row AND transitions `approved → dispatching` in one DB transaction. The outbox worker drains rows, dispatches the rail, emits the §6 audit-after, and calls `completeExecution` to settle `dispatching → executed`.
- `ApprovalService` (P0.4): stores approval signatures, enforces quorum, rejects revoked/cross-tenant/duplicate signers, and marks stale signatures when a policy version is superseded.
- Sagas (Agent Autonomy v3, 3.2): `runSaga` executes an ordered list of steps; on failure compensates completed steps in reverse, each emitting an audit event.
- Rails: `AchPlaidRail` (H-05, two-step Plaid Transfer, async webhook settlement) and `OnchainBaseRail` (H-06, viem/KMS, nonce-threaded). Stubs fail closed under `NODE_ENV=production`.

---

## 3. Actual Implementation

### PaymentIntentService

Fully implemented. Key paths:

- `create()`: evaluates policy at creation time, persists the row with `policyDecisionId`, emits `payment_intent.created`.
- `execute()`: requires `status='approved'`; builds `GateDependencies`, calls `runPreExecutionGate`; on pass: constructs the rail payload, resolves optional on-chain params and ACH credentials (never logged), atomically transitions `approved → dispatching` AND inserts the outbox row in one `withTenantScope` transaction; aborts cleanly if the intent was paused between gate and hand-off (conditional UPDATE matches no row → whole tx rolls back, no enqueue). Returns 202 with `outbox_id`.
- `completeExecution()`: idempotent — no-ops if already `executed`. One transaction: insert execution row, set receipt, transition `dispatching → executed`.
- `failExecution()`: transitions `dispatching → failed` (definitive failure only; ambiguous failures go to `reconciling` via outbox).
- `pause()` / `resume()`: kill-switch (1b.3). `resume()` re-runs the full §6 gate before re-entering `approved`.
- `pauseByAgent()`: bulk-pauses approved intents for a quarantined agent.

### State Machine

9 states: `proposed | pending_approval | approved | paused | dispatching | rejected | executed | failed | cancelled`.

Verified transitions: `approved → dispatching` (H-04 outbox path, no direct `approved → executed`); `dispatching → executed | failed` (worker-only). `executed → failed` is a legal transition (post-execution rail reversal). `paused ⇄ approved` (kill-switch). Enforced by `assertPaymentIntentTransition` at every call site.

### Outbox (H-04)

`OutboxService` is a thin SQL layer with no owned pool — accepts explicit query clients. Key guarantees:
- `enqueue()`: `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id` — idempotent on re-retry.
- `claimNext()`: `FOR UPDATE SKIP LOCKED` — concurrent workers claim disjoint row sets without blocking.
- `reclaimStale()`: returns `dispatching | dispatched` rows whose lock is older than `staleSeconds` (default 300s) to `pending`. Handles both "died before receipt persist" and "died before settle" crash cases.
- `markFailed()`: bumps `attempt_count`; at `MAX_DISPATCH_ATTEMPTS` (3) → `reconciling`. Ambiguous failures (receipt validation fail, settle DB error) always go straight to `reconciling`.

Worker wiring at `main.ts:961`:
```ts
const outboxWorker = startOutboxWorker({
  outbox: new OutboxService(),
  rails,
  executor: paymentIntentService,   // the correct service instance
  audit,
  withPrivileged,
  workerId: `outbox-worker-${process.pid}`,
}, { intervalMs: 1_000 });
```
`withPrivileged` uses `DATABASE_PRIVILEGED_URL` if set, falling back to `DATABASE_URL` with a `console.warn`. The `privilegedPool` is never closed in `shutdown()` (R-15, confirmed previously in `runtime/boot.md`).

### ApprovalService (P0.4)

All four guards in `sign()`:
1. Revoked signer: `isApproverActive(ctx, ctx.actor) → false` → `approval_signer_revoked`.
2. Cross-tenant: `resolveSubjectOwnerTenant` ≠ `ctx.tenantId` → `approval_cross_tenant`.
3. Duplicate signer: `findApprovalForSigner` non-null → `approval_duplicate_signer` (hard reject, not silent no-op).
4. Policy-version staleness: `resolveActivePolicyVersion` recorded on insert; `markStaleForSupersededVersion` called in `signedValidRoles`.

`hasRequiredApprovals()` passes through `signedValidRoles` which excludes stale signatures. Quorum logic: `every required role in signedRoles set`. At `main.ts:801` the primary `approvalService` is fully wired with all four optional hooks. At `main.ts:1286` the HTTP payment-intent plugin creates a fresh `piApprovals` — also fully wired.

### Sagas (`runSaga`)

`runSaga` is correctly implemented: iterates steps forward, on any throw compensates done steps in reverse, emits per-compensation audit events, final `agent.saga.failed` or `agent.saga.completed`. Compensation failures are tracked and emitted separately (`agent.saga.compensation_failed`). The `SagaResult` type surfaces all outcomes to the caller.

**Gap: no production callers.** `runSaga` is exported at `index.ts:98` and tested in `sagas.test.ts`, but has zero call sites in production code. The schema tables (`agent_action_sagas`, `agent_saga_steps`, migration 0016) exist and have FORCE RLS, but are never written to. The executor's docstring explicitly defers persistence: "persistence of saga/step rows … is the caller's concern." No caller exists.

### Rails

- `AchPlaidRail.dispatch()`: two-step Plaid Transfer — `transferAuthorizationCreate` (idempotency-keyed) then `transferCreate` (with `client_transaction_id`). Returns `status: 'pending'` — ACH settles asynchronously via `TRANSFER_EVENTS_UPDATE` webhook.
- `OnchainBaseRail.dispatch()`: reads live session-key nonce via `getSessionKeyNonce`, then calls `executor.execute()`. `BadNonce` and `ReentrantCall` surface as `execution_rail_declined`.
- `defaultRails()`: stubs fail closed at `assertStubRailsAllowed()` under `NODE_ENV=production`.
- Boot (main.ts:886–913): real rails registered conditionally — Plaid only if `PLAID_CLIENT_ID` + `PLAID_SECRET` present; on-chain only if `BRAIN_SESSION_KEY` + `BASE_RPC_URL` present. If neither is configured, `defaultRails()` is used (with its production fence).

**Gap: `applyPlaidTransferEvent` is never called.** The function is defined at `ach-plaid.ts:218`, exported at `index.ts:47`, and designed to be called by the `/raw/webhooks/plaid` handler on `TRANSFER_EVENTS_UPDATE` events. Neither `services/api/src/main.ts` nor `services/raw/` references it. ACH payments dispatched via the real `AchPlaidRail` will never receive a terminal settlement event from Brain — the intent remains stuck in `dispatching` until the outbox worker exhausts its 3-attempt budget and routes to `reconciling`.

---

## 4. Runtime Validation

```
# Typecheck
$ pnpm --filter @brain/execution run typecheck
> tsc --noEmit -p tsconfig.typecheck.json
[no output — 0 errors]

# Tests
$ pnpm --filter @brain/execution run test
Test Files  22 passed (22)
     Tests  168 passed (168)
  Duration  6.92s

# runSaga call-site search
$ grep -rn "runSaga|SagaStep" services/ --include="*.ts" | grep -v test | grep -v sagas.ts
/home/.../services/execution/src/index.ts:98:export { runSaga, type SagaStep, ... }
/home/.../services/execution/dist/sagas.d.ts:...
# → export-only, no production callers

# agent_action_sagas DB consumers
$ grep -rn "agent_action_sagas|agent_saga_steps" services/ --include="*.ts"
/home/.../services/execution/src/sagas.ts:12: (comment only)
/home/.../services/execution/dist/sagas.d.ts:12: (comment only)
# → tables exist, never queried/inserted in production

# applyPlaidTransferEvent callers
$ grep -rn "applyPlaidTransferEvent|TRANSFER_EVENTS_UPDATE" services/ --include="*.ts" | grep -v test
/home/.../services/execution/src/index.ts:47:  applyPlaidTransferEvent,  ← export only
/home/.../services/execution/src/rails/ach-plaid.ts:15: (comment)
# → no webhook handler calls it
```

168 tests, 0 typecheck errors.

---

## 5. Functional Status

**Mostly Working**

The core execute path — §6 gate → durable outbox hand-off → worker drain → settle — is correctly implemented and well-tested. The ApprovalService quorum logic with P0.4 hardening is correct. The state machine is sound. Rails are real implementations that fail closed in production without credentials.

Two production gaps prevent full production-readiness:
1. ACH payments dispatched via the real `AchPlaidRail` cannot auto-settle (webhook handler missing).
2. Saga compensation exists as a library but is never called in production code.

---

## 6. Architectural Violations

None of the standard violations (layer leakage, circular deps, business logic in transport) are present.

The `PaymentIntentService` reads `ledger_payment_intents` via the `LedgerPaymentIntents` facade from `@brain/ledger` — not raw SQL — preserving the "every service owns its schema" rule. The comment at `PaymentIntentService.ts:9` documents this.

One R-20 wiring mismatch: the HTTP-path `piService` at `main.ts:1294` omits `resolveTenantFlags`, while the agent/MCP-path service at `main.ts:870` includes it. This is a pre-existing finding (R-20 in the risk register). No new violations found.

---

## 7. Missing Pieces

1. **ACH webhook settlement unwired** — `applyPlaidTransferEvent` is defined and exported but has no caller in the Plaid webhook handler. ACH intents dispatched via `AchPlaidRail` remain stuck in `dispatching` until the outbox exhausts retries (→ `reconciling`). Any production ACH flow using Plaid credentials requires this wiring to ever auto-settle.

2. **Saga persistence gap** — `runSaga` is a pure in-memory executor. The `agent_action_sagas` and `agent_saga_steps` DB tables exist (migration 0016, with FORCE RLS) but are never written to. Compensation logic is correct and audited, but there is no persistent saga record that ops or replay could inspect. No production caller exists.

3. **`privilegedPool` not closed on shutdown** — already documented as R-15. The `outboxWorker` uses `privilegedPool` which is never closed in `shutdown()`.

4. **`piService` missing `resolveTenantFlags`** — R-20. HTTP payment-intent execute path skips gate check 1.5 (behavior hash) for all callers.

5. **`DATABASE_PRIVILEGED_URL` optional in dev** — the outbox worker falls back to `DATABASE_URL` (no BYPASSRLS) with a `console.warn`. Under dev conditions the worker runs as the table owner, bypassing the RLS policies that would otherwise scope `claimNext` to the calling tenant. This is explicitly documented in the boot code comment as "dev/testnet only" but is not enforced — if `DATABASE_PRIVILEGED_URL` is missing in a staging/pre-prod environment, cross-tenant outbox claims would be RLS-blocked (the owner role still sees all rows — FORCE RLS wouldn't apply to the owner without explicit BYPASSRLS, so actually the worker would accidentally claim all tenants' rows via the owner role).

---

## 8. Evidence

**Atomic hand-off (`PaymentIntentService.ts:602–617`):**
```ts
const handoff = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
  assertPaymentIntentTransition("approved", "dispatching");
  const moved = await LedgerPaymentIntents.transition(c, intent.id, "approved", "dispatching");
  if (moved === null) {
    const cur = await LedgerPaymentIntents.findById(c, intent.id);
    return { ok: false as const, status: cur?.status ?? "missing" };
  }
  const enq = await this.deps.outbox.enqueue(c, ctx.tenantId, { ... });
  return { ok: true as const, outboxId: enq.id };
});
```
One transaction: the conditional UPDATE and the outbox INSERT are atomic. A crash between gate and hand-off leaves no row in the outbox.

**Stale reclaim (`OutboxService.ts:236–246`):**
```ts
UPDATE execution_outbox
   SET status = 'pending', locked_at = NULL, locked_by = NULL
 WHERE status IN ('dispatching', 'dispatched')
   AND locked_at IS NOT NULL
   AND locked_at < now() - ($1 * interval '1 second')
```
Handles both "receipt not persisted" and "settle not completed" crash cases.

**ApprovalService duplicate signer reject (`ApprovalService.ts:100–104`):**
```ts
const existing = await findApprovalForSigner(c, subject.type, subject.id, ctx.actor);
if (existing !== null) {
  throw brainError("approval_duplicate_signer", "principal has already signed this subject", ...);
}
```
Changed from silent no-op in pre-P0.4 to hard reject.

**`runSaga` call-site evidence:**
```
grep -rn "runSaga" services/ --include="*.ts" | grep -v test | grep -v sagas.ts
→ only index.ts:98 (export), no production invocation
```

**`applyPlaidTransferEvent` call-site evidence:**
```
grep -rn "applyPlaidTransferEvent" services/ --include="*.ts" | grep -v test
→ only index.ts:47 (export), no webhook handler
```

**Rail fail-closed guard (`stubs.ts:24–30`):**
```ts
function assertStubRailsAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("stub payment rails cannot settle money in NODE_ENV=production ...");
  }
}
```

**FORCE RLS (`migrations/0019_force_rls.sql`):** 16 tables including `execution_outbox`, `agent_action_sagas`, `agent_saga_steps`, `approvals`.

---

## 9. Confidence Level

**High**

All key files were read in full. The execute path, outbox cycle, approval quorum, and saga executor were traced from interface to implementation to test. The two production gaps (ACH settlement, saga persistence) were independently confirmed by exhaustive grep across the full `services/` tree finding zero call sites. The typecheck and 168-test run provide additional correctness confidence for the unit-tested paths.

---

## 10. Production Readiness

**Score: 7/10**

**Blockers:**

1. **(High) ACH webhook settlement unwired.** If `PLAID_CLIENT_ID` + `PLAID_SECRET` are configured (real ACH rail active), every ACH payment intent will be dispatched to Plaid successfully but will never auto-settle. The `TRANSFER_EVENTS_UPDATE` webhook from Plaid has no handler that calls `applyPlaidTransferEvent`. The intent sits in `dispatching`, the outbox worker retries 3 times, then routes to `reconciling`. No money is lost (Plaid has the transfer), but every ACH payment requires manual ops intervention to close. **Fix:** in the `/raw/webhooks/plaid` handler, resolve `transfer_id → outbox row` and call `applyPlaidTransferEvent(outbox, client, outboxId, event)`.

2. **(Medium) Saga persistence missing.** `runSaga` compensates correctly in memory and emits audit events, but nothing writes to `agent_action_sagas` or `agent_saga_steps`. There is no persistent saga record. For post-incident investigation or saga state recovery, the audit log is the only record (with no structured saga-step view). **Fix:** add `agent_action_sagas` / `agent_saga_steps` persistence inside `runSaga` or in a wrapper layer before any production caller is introduced.

3. **(Medium) R-20 confirmed:** HTTP payment-intent execute path (`piService` at `main.ts:1294`) missing `resolveTenantFlags`; gate check 1.5 (behavior hash) silently skipped for all `POST /v1/payment-intents/{id}/execute` callers.

4. **(Medium) R-15 confirmed:** `privilegedPool` not closed in `shutdown()`. On every SIGTERM the privileged connection pool leaks.

**Risks:**

- `DATABASE_PRIVILEGED_URL` missing from staging → outbox worker runs as table owner, no BYPASSRLS isolation. The owner role sees all rows — the intent is "cross-tenant drain," but without the `brain_privileged` role this bypasses the intended security boundary.
- The real on-chain rail requires `BRAIN_SESSION_KEY` (private key in env). No KMS fallback at runtime — if the env var is a raw private key, it's exposed in the process environment. KMS is the intended path (per CLAUDE.md), but the README defers this to a follow-up. This is a secrets-handling concern for the security audit.

---

## 11. Refactor Priority

**Medium** for the saga persistence gap (library without callers is zero value, and the tables exist waiting to be used).

**High** for the ACH webhook wiring — this is a functional gap that blocks production ACH settlement. Once `PLAID_CLIENT_ID`/`PLAID_SECRET` are configured, every ACH payment becomes a manual reconciliation case without this fix.

The outbox, state machine, and approval logic are sound and do not need refactoring — they are production-quality.
