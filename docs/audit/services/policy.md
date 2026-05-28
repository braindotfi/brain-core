# Audit: services/policy (`@brain/policy`)

**Audited:** 2026-05-26
**Files examined:**
- `services/policy/src/vm.ts`
- `services/policy/src/dsl.ts`
- `services/policy/src/signing.ts`
- `services/policy/src/service.ts`
- `services/policy/src/routes.ts`
- `services/policy/src/repository.ts`
- `services/policy/src/spend-counters.ts`
- `services/policy/src/linter.ts`
- `services/policy/src/deps.ts`
- `services/policy/src/vm.test.ts`
- `services/policy/src/adversarial.test.ts`
- `services/policy/src/vm-agent-output.test.ts`
- `services/policy/src/routes.sign-quorum.test.ts`
- `services/policy/src/signing.test.ts`
- `services/policy/src/repository.policy.test.ts`
- `services/policy/src/spend-counters.test.ts`
- `services/policy/migrations/0001_policies.sql`
- `services/policy/migrations/0002_policy_decisions.sql`
- `services/policy/migrations/0003_policy_spend_counters.sql`
- `services/policy/migrations/0004_force_rls.sql`
- `services/api/src/policy/viemPolicySignerChecker.ts`
- `services/api/src/main.ts` (lines 748–1092, relevant policy wiring)
- `services/agent-router/src/action-resolver.ts`
- `scripts/check-policy-no-wiki-read.mjs` (run live)

**Commands run:**
- `pnpm -C services/policy run test` → 89 tests, 12 files, all pass
- `pnpm -C services/policy run typecheck` → 0 errors
- `node scripts/check-policy-no-wiki-read.mjs` → `policy-no-wiki-read guard: OK`
- `grep -rn "incrementSpendCounter" ... | grep -v ".test.ts" | grep -v "dist/"` → only definition and export, zero call sites

---

## 1. Scope

This report covers `@brain/policy` (Layer 4): the rule VM (`vm.ts`), the DSL schema (`dsl.ts`), EIP-712 signing (`signing.ts`), quorum enforcement (`routes.ts`), the policy state machine (`repository.ts`), the spend-counter store (`spend-counters.ts`), the policy linter (`linter.ts`), and all wiring of `PolicyService` / `PolicyDeps` in `services/api/src/main.ts`.

Out of scope: the §6 gate itself (in `shared/src/gate/gate.ts`, covered in the execution audit), on-chain `BrainPolicyRegistry` (covered in `contracts/foundry.md`), and the approval workflow (`ApprovalService`) in `services/execution` (covered there).

---

## 2. Intended Architecture

Per `Brain_MVP_Architecture.md` §3 Layer 4 and the CLAUDE.md policy section:

- **Deterministic rule VM** — 6 MVP primitives + 7 Agent Autonomy v3 extensions + 3 H-16 agent-output gating signals; no LLM, no Wiki reads.
- **EIP-712 signed policies** — `compose` → `pending_signatures` → `active`; quorum of authorized signers verified against on-chain `BrainPolicyRegistry.isTenantSigner`.
- **`agent_actions` allowlist (H-23)** — a `PolicyDocument.agent_actions` map restricts which action keys each named agent may request. Enforced at the `ActionResolver`.
- **Spend envelopes (1b.2)** — `policy_spend_counters` accumulates per-agent aggregate spend per tumbling window; the gate reads counters pre-evaluation and increments them post-execution.
- **Per-layer isolation** — policy never reads Wiki; `check-policy-no-wiki-read.mjs` enforces this in CI.

---

## 3. Actual Implementation

### 3.1 Rule VM (`vm.ts`)

`evaluate(policy, action)` iterates rules, calls `matchRule` for each, and returns the first matching rule's outcome. Default-deny: no match → `reject`. Correct first-match semantics.

`matchRule` evaluates all `when` primitives in order: `counterparty.in`, `counterparty.not_in`, `amount.lte`, `amount.gt`, `agent.role`, `time_window`, `agent.id`, `tenant.category`, `action.in`, `action.not_in`, `agent.behaviorHash`, `agent.spend_in_window`, `agent.tx_count_in_window`, `agent.confidence.gte`, `agent.evidence_score.gte`, `agent.risk_level.lte` — all fail-closed when the corresponding action field is missing.

**`compareDecimal`** (the P0 #2-adjacent fix): Implemented via `normalizeDecimal` → `compareBigNumeric`. Uses only string operations and BigInt; no floating-point arithmetic. Handles negative zero explicitly at `vm.ts:261` (`if (fracCmp === 0) return 0;` prevents `-0`). `addDecimal` uses the same BigInt path. Property-tested with fast-check over integers ±1M.

**`approval_required_above`** (1b.5): Correctly forces `confirm` even when `execute: "auto"`, checked after `mapExecute` so the rule can still be the matching rule but its outcome is overridden. Default approvers is `["signer"]` when none are declared (`vm.ts:68`).

**H-16 agent-output gating**: `agent.confidence.gte`, `agent.evidence_score.gte`, `agent.risk_level.lte` all fail closed on missing signal (no default-trust). `RISK_RANK` total-order: `{ low:0, medium:1, high:2, critical:3 }`, with `?? 99` for unknown actual levels.

### 3.2 EIP-712 Signing (`signing.ts`)

Full EIP-712 implementation in ~230 lines using `@noble/hashes/sha3`. Does not depend on viem for signature generation — only for verification at the `/sign` route (`viem.verifyTypedData`). Domain separator, struct hash, and `encodeField` are correct against the EIP-712 spec for `bytes32`, `address`, `string`, and `uint*` types.

`tenantIdToBytes32`: `keccak256(tenantId)` — deterministic, irreversible. Matches `keccak256(abi.encodePacked(tenantId))` on-chain (per comment).

### 3.3 Quorum Enforcement (`routes.ts`)

`POST /policy/:tenant_id/sign` enforces three guards before counting a signature toward quorum:

1. **Valid EIP-712 signature** — `verifyTypedData` with the reconstructed domain.
2. **Non-duplicate signer** — `seen` Set, rejects same address twice (`routes.ts:186-190`).
3. **Authorized tenant signer** — `deps.isAuthorizedSigner(tenant, sig.address)` (`routes.ts:193`).

In `main.ts:757-762`:
- Demo mode: `() => Promise.resolve(true)` (any signer accepted in sandbox).
- Production mode: `createViemPolicySignerChecker` reads `BrainPolicyRegistry.isTenantSigner` on-chain. **Fail-closed**: any RPC error returns `false` (`viemPolicySignerChecker.ts:46`).

Policy activates atomically: `transition(c, id, "pending_signatures", "active")` first runs `UPDATE ... state = 'deactivated'` on any currently active policy, then UPDATEs the new one. Backed by `UNIQUE INDEX ... WHERE state = 'active'` at the DB layer.

### 3.4 H-23 Agent Action Allowlist — NOT WIRED

`PolicyDocument.agent_actions` and `allowedActionsFor(doc, agentKey)` are correctly defined (`dsl.ts:114-124`) and exported. The `ActionResolver` in `services/agent-router/src/action-resolver.ts` has an optional `isActionAllowed` dep (`action-resolver.ts:53`).

**Gap**: At `main.ts:1092`, `ActionResolver` is constructed **without** `isActionAllowed`:

```ts
const actionResolver = new ActionResolver({ classifier: agentClassifier });
```

The comment at `main.ts:1085-1091` explicitly acknowledges this: "Until wired, an explicit action is accepted if the agent offers it (pre-H-23 behavior)." This means the `agent_actions` field in the signed policy has no runtime enforcement. An agent can request any action it offers regardless of the signed policy's per-agent allowlist.

### 3.5 Spend Counter Increment — NOT WIRED

`incrementSpendCounter` in `spend-counters.ts:65` is exported at `index.ts:71` but has **zero call sites** outside the policy package definition. Confirmed by global grep across all TS source files.

The gate reads spend counters (`evaluateForGate` → `readSpendWindow`/`readTxCountWindow` → `policy_spend_counters`), but nothing increments the counters after a successful execution. The spend-counter comment at `spend-counters.ts:8` states: "The gate reads the current bucket to evaluate ... then (on a passing LIVE gate, never dry-run) increments it." This never happens.

Effect: All agents always see the same spend-window values (initial or stale). Spend-envelope rules (`agent.spend_in_window`, `agent.tx_count_in_window`) check correctly on the first execution of the window, but subsequent executions see the same unchanged counters and can breach the cap without the VM detecting it.

### 3.6 `tenant.category` Hardcoded

In `service.ts:163`, `evaluateForGate` sets `tenant_category: "business"` unconditionally. A TODO comment acknowledges this: "resolve real tenant category (router defaults to 'business' today)." All `tenant.category: "consumer"` policy rules are effectively dead — they never match because every gate call presents "business".

### 3.7 Linter (`linter.ts`, H-18)

9 lint rules:

| Code | Severity | Checks |
|------|----------|--------|
| `auto_no_amount_cap` | ERROR | Auto money-mover has no `amount.lte` / `approval_required_above` |
| `auto_no_counterparty_constraint` | ERROR | Auto money-mover has no counterparty constraint |
| `auto_no_verified_counterparty` | ERROR | Auto money-mover missing `counterparty.in` allowlist |
| `no_approval_path_high_value` | ERROR | Can auto-execute above high-value threshold with no approval path |
| `unsupported_currency` | ERROR | References a non-supported currency |
| `invalid_approval_role` | ERROR | `require` references an unknown approver role |
| `auto_no_risk_bound` | ERROR | Auto money-mover has no `agent.risk_level.lte` |
| `broad_any_auto` | ERROR | `applies_to: any` with `execute: auto` |
| `unreachable_rule` | WARN | Rule after a catch-all (first match semantics) |
| `zero_recent_matches` | WARN | Data-dependent; only when `recentMatchCounts` is supplied |

The linter is pure over a `PolicyDocument`; it is exposed at `POST /policy/:tenant_id/lint`. There is no enforcement that a policy must pass the linter before activation — a policy with lint ERRORs can be signed and activated.

### 3.8 State Machine (`repository.ts`)

Valid transitions: `draft → pending_signatures | cancelled`, `pending_signatures → active | expired`, `active → deactivated`. Terminal states (`deactivated`, `cancelled`, `expired`) have no exits. `isValidTransition` throws on any other pair. The `WHERE state = $3` in the UPDATE serves as a CAS guard against concurrent state changes.

### 3.9 Migrations

4 migrations, no prefix conflicts:

- `0001_policies.sql` — `policies` table, partial unique index on `(tenant_id) WHERE state = 'active'`, ENABLE RLS
- `0002_policy_decisions.sql` — `policy_decisions` table, ENABLE RLS
- `0003_policy_spend_counters.sql` — `policy_spend_counters` with `period_window` (P0 #2 fix — `window` was a Postgres reserved keyword)
- `0004_force_rls.sql` — FORCE RLS on all three tables

---

## 4. Runtime Validation

```
$ pnpm -C services/policy run test
 ✓ src/duplicate-detector.test.ts (9 tests)
 ✓ src/signing.test.ts (5 tests)
 ✓ src/vm.test.ts (24 tests)
 ✓ src/policy-tools.test.ts (10 tests)
 ✓ src/dsl.test.ts (7 tests)
 ✓ src/spend-counters.test.ts (4 tests)
 ✓ src/adversarial.test.ts (3 tests)
 ✓ src/vm-agent-output.test.ts (6 tests)
 ✓ src/repository.test.ts (5 tests)
 ✓ src/repository.policy.test.ts (12 tests)
 ✓ src/index.test.ts (1 test)
 ✓ src/routes.sign-quorum.test.ts (3 tests)
 Test Files  12 passed (12)
      Tests  89 passed (89)
   Duration  2.67s
```

```
$ pnpm -C services/policy run typecheck
(no errors)
```

```
$ node scripts/check-policy-no-wiki-read.mjs
policy-no-wiki-read guard: OK
```

```
$ grep -rn "incrementSpendCounter" ... | grep -v ".test.ts" | grep -v "dist/"
services/policy/src/index.ts:71:  incrementSpendCounter,   ← export only; no call site
services/policy/src/spend-counters.ts:65: export async function incrementSpendCounter(
```

**`routes.sign-quorum.test.ts` coverage:**
- `it("rejects forged quorum from signers absent from the on-chain allowlist")` → 400 `policy_signature_invalid`
- `it("rejects a duplicate signer padding quorum with the same key twice")` → 400 `policy_signature_invalid`
- `it("activates when quorum-many distinct authorized signers sign")` → 200 `{ activated: true }`

All three pass using real `viem/accounts` key generation and actual `verifyTypedData`.

---

## 5. Functional Status

**Mostly Working**

The rule VM is correct, the EIP-712 signing machinery is sound, and on-chain quorum enforcement is wired and security-tested. Two concrete runtime gaps prevent full "Working" status:

1. Spend counter increment path never executes — spend-envelope rules evaluate correctly on read, but the counters never grow, so the aggregate cap is effectively bypassed after the first execution in a window.
2. H-23 agent action allowlist (`isActionAllowed`) is not injected at the `ActionResolver` construction site — the signed policy's `agent_actions` field has no runtime effect.

---

## 6. Architectural Violations

**`simulate-historical` reads `ledger_payment_intents` directly** (`routes.ts:354-380`). This is a Policy→Ledger cross-service DB read. It is the sanctioned §6 read-only exception documented in CLAUDE.md: "Policy reads Ledger state (sanctioned §6 read; never Wiki). RLS scopes it." The route comment confirms this explicitly. Not a violation.

**Linter NOT gating activation** — a policy with lint ERRORs (`auto_no_amount_cap`, `broad_any_auto`, etc.) can be signed and activated. The linter is advisory. This is a design gap: the spec does not mandate lint-gating activation, but dangerous policies (auto money-movement with no amount cap) can reach `active` state. This is architectural debt, not a layer violation.

No Wiki imports found in policy source. No circular deps.

---

## 7. Missing Pieces

1. **`incrementSpendCounter` never called** — spend-envelope protection (`agent.spend_in_window`, `agent.tx_count_in_window`) reads counters but never updates them after execution. Must be called inside the gate commit transaction when `dryRun === false`, before the audit-before event.

2. **H-23 `isActionAllowed` not wired** — `new ActionResolver({ classifier: agentClassifier })` at `main.ts:1092` omits the hook. Fix: supply `isActionAllowed: (agentKey, action) => allowedActionsFor(policyGetActive(tenantId), agentKey).includes(action)` using the requesting tenant's active policy.

3. **`tenant.category` hardcoded "business"** — `service.ts:163`. Consumer-tenant policies with `tenant.category: "consumer"` rules will never match.

4. **Linter not enforced at activation** — dangerous policies can bypass lint checks and reach `active` state.

5. **No integration tests** — all 89 tests are unit tests against fake/mocked DB clients. No end-to-end sign-and-evaluate path exercised against a real Postgres instance.

---

## 8. Evidence

**`compareDecimal` correctness** — `vm.ts:251-263`: uses `normalizeDecimal` (string ops only) and `compareBigNumeric` (string length then lexicographic). Negative-zero guard at line 261. Fast-check property test at `vm.test.ts:31-44` hammers over integers ±1M.

**Quorum enforcement** — `routes.ts:165-200`:
```ts
// 1. EIP-712 verify
const ok = await verifyTypedData({ address, domain, types, primaryType, message, signature });
if (!ok) throw brainError("policy_signature_invalid", ...);

// 2. Duplicate signer guard
if (seen.has(addr)) throw brainError("policy_signature_invalid", "duplicate signer", ...);
seen.add(addr);

// 3. On-chain allowlist
if (!(await deps.isAuthorizedSigner(tenant, sig.address)))
  throw brainError("policy_signature_invalid", "signer is not an authorized tenant signer", ...);
```

**H-23 not wired** — `main.ts:1092`:
```ts
const actionResolver = new ActionResolver({ classifier: agentClassifier });
// isActionAllowed is not supplied → any offered action is accepted
```

Comment at `main.ts:1085-1091` confirms this is intentional-but-deferred.

**Spend counter increment absent** — global grep result shows `incrementSpendCounter` appears only in `spend-counters.ts` (definition) and `index.ts` (export). Zero callers across the entire codebase.

**FORCE RLS** — `0004_force_rls.sql`:
```sql
ALTER TABLE policies               FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions       FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_spend_counters  FORCE ROW LEVEL SECURITY;
```

All three policy-owned tables covered. Live DB: unverified (CI-only).

**Spend counter comment (design intent)** — `spend-counters.ts:8-9`: "The gate reads the current bucket to evaluate ... then (on a passing LIVE gate, never dry-run) increments it." Not implemented.

---

## 9. Confidence Level

**High**

The VM, signing, and quorum path are fully readable and well-covered by tests including real EIP-712 key operations. The two runtime gaps (spend increment, H-23 hook) are directly verifiable by grep and code inspection of `main.ts`. No ambiguity in the evidence. Live DB state (FORCE RLS enforcement) and on-chain signer allowlist (Base Sepolia) remain CI-only/chain-unavailable but are not needed to verify the code-level findings.

---

## 10. Production Readiness

**Score: 7/10**

**Working:**
- Rule VM: correct, deterministic, property-tested, default-deny
- EIP-712 signing: sound, no floating-point, deterministic across identical inputs
- Quorum signing: on-chain signer allowlist enforced, duplicate-signer rejected, fail-closed on RPC error
- Policy state machine: DB-enforced partial unique index, atomic deactivation of N before activating N+1
- FORCE RLS: all three tables covered (code-verified)
- policy-no-wiki-read: clean

**Blockers:**

- **Spend counter increment never fires (High)**: The aggregate spend caps (`agent.spend_in_window`, `agent.tx_count_in_window`) are never updated. Every agent call sees counters at 0 (or their initial value). An agent can execute unlimited transactions as long as each call individually appears to be within the cap. The protection looks real in the VM but is structurally broken in production.

- **H-23 agent action allowlist not wired (Medium)**: The signed policy's `agent_actions` map has no runtime effect. Agents can request any action they offer regardless of the policy. This makes the per-agent action restriction feature non-functional in production.

**Risks:**

- `tenant.category` always "business": consumer-specific policy rules are dead code in production; a consumer-segment launch would require fixing this first.
- Lint not enforced at activation: a human error producing a dangerous auto-execute policy (no amount cap) can reach `active` state without any system-level rejection.

---

## 11. Refactor Priority

**High**

The spend counter increment gap is the highest priority fix in the policy layer. It is a functional correctness defect in the aggregate spend protection, which is the primary mechanism for bounding autonomous agent financial exposure. Fix: call `incrementSpendCounter` inside the gate's live execution path (inside the `dryRun === false` branch, within the same transaction as the policy decision INSERT).

H-23 wiring is the next priority: inject `isActionAllowed` into `ActionResolver` at `main.ts:1092` using a per-request load of the tenant's active policy (already imported as `policyGetActive`).

The `tenant.category` hardcoding is Medium priority — no consumer-facing product has launched yet, so the urgency is lower, but it must be resolved before any consumer-segment deployment.
