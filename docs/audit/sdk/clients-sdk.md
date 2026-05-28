# Audit #13 — SDK / Generated Client (`@brain/sdk`)

**Subsystem**: `clients/sdk/` — `@brain/sdk v0.1.0-rc.0`, OpenAPI-typed client
**Auditor**: Evidence-driven, commands executed 2026-05-26
**Status**: Complete
**Score**: 6 / 10

---

## 1. Scope

This audit covers:
- Build, typecheck, and test results
- Sync state between `src/generated/openapi.d.ts` and `Brain_API_Specification.yaml`
- Whether `codegen:check` runs in CI
- Surface coverage (which API routes the SDK wraps)
- Internal consumers of `@brain/sdk` across the monorepo
- npm publication status

Out of scope: external consumers, docs site alignment, versioning strategy.

---

## 2. Evidence Collected

### Test suite

```
pnpm -C clients/sdk run test
→ 11 test files, 120 tests: all passed
→ Duration: 1.27s
```

### Typecheck

```
pnpm -C clients/sdk run typecheck
→ tsc -b --noEmit: no errors
```

### Codegen drift check

```
pnpm -C clients/sdk run codegen:check
→ Files src/generated/openapi.d.ts and /tmp/brain-sdk-openapi.d.ts differ
→ Exit code 1

git diff after regeneration:
  clients/sdk/src/generated/openapi.d.ts | 479 +++++++++++++++++++++------
  1 file changed, 393 insertions(+), 86 deletions(-)
  27 hunks
```

**The committed `openapi.d.ts` is out of sync with the current spec.**

### CI pipeline check

```
.github/workflows/pr.yml — no `codegen:check` step
package.json root scripts — no `codegen:check` invocation
```

Codegen drift check is not wired into CI. Drift accumulates silently.

### Internal consumer search

```
grep -rn "@brain/sdk" services/ tests/ → 0 results
```

Zero internal consumers. The e2e test client (`tests/e2e/lib/client.ts`) is a handwritten raw-fetch `BrainClient`, not `@brain/sdk`.

---

## 3. Source Tree

```
clients/sdk/
  src/
    brain.ts               # Brain class: all resources + pay/ask/snapshot/trace/proof helpers
    client.ts              # createBrainHttpClient (openapi-fetch wrapper)
    errors.ts              # BrainAPIError, PolicyApprovalRequiredError, PolicyRejectedError
    index.ts               # public re-exports
    generated/
      openapi.d.ts         # openapi-typescript generated types (STALE — see §4)
    resources/
      actions.ts           # ActionsResource: propose, approve, execute, escalate
      agent-runs.ts        # AgentRunsResource: get, why, proof
      agents.ts            # AgentsResource: list, get, register, proposeFromAgent
      audit.ts             # AuditResource: list, get, export, verify + AnchorResource
      compounds.ts         # CompoundsResource: snapshot, trace + CashFlowResource
      ledger.ts            # AccountsResource, TransactionsResource, CounterpartiesResource,
                           # ObligationsResource, InvoicesResource, BalancesResource
      payments.ts          # PaymentsResource: create, execute, approve, reject, cancel
      policy.ts            # PolicyResource: get, sign, simulate, lint, diff, history
      proof.ts             # ProofResource: get (canonical H-07 proof)
      raw.ts               # RawResource: ingest, get, getParsed
      wiki.ts              # WikiResource: search, getEntity, question, annotate
  package.json             # @brain/sdk v0.1.0-rc.0, private: true, not published
```

---

## 4. Codegen Drift Analysis

### What differs

The committed `openapi.d.ts` was generated from an earlier snapshot of `Brain_API_Specification.yaml`. The current spec differs in 27 hunks. Categories:

| Category | Direction | Impact |
|----------|-----------|--------|
| `@deprecated` markers on `proposeAgentAction` + `registerAgent` | In spec now, not in committed | Low — doc-only in generated types |
| Expanded description blocks for `listAgents`, `getAgent`, `getAgentRunWhy`, proof endpoints | In spec now, not in committed | Low — doc-only |
| `parameters: { ... }` formatting change (inline → multiline) | In spec now, not in committed | None — structurally identical |
| Response type changes for deprecated endpoints (Agent/AgentRun → Error) | In spec now, not in committed | **Medium** — TS types diverge from runtime |

### Severity of drift

The type changes for deprecated endpoints are the only structurally meaningful divergence. Specifically:
- `POST /agents/{id}/actions` (`proposeAgentAction`): spec now marks as `@deprecated` and returns 404 — the committed type still shows the old response schema.
- `POST /agents/register` (`registerAgent`): same — spec deprecated it to document the still-live legacy route.

These are not new required fields — the committed types are a subset of the current spec. The SDK won't type-error against the runtime response because the deprecated paths return 404, not a mismatched schema. **Type safety is not broken; it is stale.**

The `agents?: components["schemas"]["Agent"][]` field visible in the committed `openapi.d.ts` for `listAgents` but not in the fresh types suggests a response shape was simplified in the spec. This is the only case where the committed type is RICHER than the spec — callers using `response.agents` would typecheck against the committed type but receive a different shape at runtime if the spec change was also implemented server-side.

---

## 5. Surface Coverage

The SDK wraps these route groups:

| Resource class | Routes covered | Notes |
|---------------|---------------|-------|
| `AccountsResource` | `GET /ledger/accounts`, `GET /ledger/accounts/{id}` | Ledger L2 |
| `TransactionsResource` | `GET /ledger/transactions`, `GET /ledger/transactions/{id}` | Ledger L2 |
| `CounterpartiesResource` | `GET /ledger/counterparties`, `GET /ledger/counterparties/{id}` | Ledger L2 |
| `ObligationsResource` | `GET /ledger/obligations`, `GET /ledger/obligations/{id}` | Ledger L2 |
| `InvoicesResource` | `GET /ledger/invoices` | Ledger L2 |
| `BalancesResource` | `GET /ledger/balances` | Ledger L2 |
| `AuditResource` + `AnchorResource` | `GET /audit/events`, `GET /audit/events/{id}`, export, verify, anchors | Audit L6 |
| `ProofResource` | `GET /proof/{id}` | H-07 canonical proof |
| `AgentRunsResource` | `GET /agents/runs/{id}`, why, proof | Agent-run history |
| `PaymentsResource` | Full payment-intent lifecycle (create, execute, approve, reject, cancel) | L5 |
| `ActionsResource` | propose, approve, execute, escalate | L5 |
| `AgentsResource` | list, get, register, proposeFromAgent | L5 catalog |
| `RawResource` | ingest, get, getParsed | L1 |
| `WikiResource` | search, getEntity, question, annotate | L3 |
| `PolicyResource` | get, sign, simulate, lint, diff, history | L4 |
| `CompoundsResource` | `snapshot`, `trace` client-side aggregates | Client-side |
| `CashFlowResource` | `summarize` | Client-side |

**Compound helpers on `Brain`**: `pay`, `approve`, `reject`, `ask`, `snapshot`, `trace`, `proof` — these are the "homepage" developer-facing shortcuts.

Coverage is broad — all six layers plus the agent, audit, proof surfaces. No obvious missing routes.

---

## 6. Consumer Reality

`@brain/sdk` has **zero internal consumers**. It is:
- `private: true` in `package.json` — not publishable to npm in current state
- Explicitly noted as unpublished in CLAUDE.md (R-10)
- Not imported by any service, test, or script in the monorepo

The three Series A e2e tests (`tests/e2e/`) use a handwritten raw-fetch `BrainClient` with no type safety from the spec. If `@brain/sdk` were used there, codegen drift would surface as a test failure — the current setup provides no such signal.

The SDK is maintained as a standalone artifact with its own test suite (120 tests, all passing). It has no integration with the rest of the test estate.

---

## 7. Build Mechanics

- Codegen: `openapi-typescript >=7.5.0` → `src/generated/openapi.d.ts` from `Brain_API_Specification.yaml`
- Transport: `openapi-fetch ^0.13.0` — type-safe fetch wrapper keyed on the generated path types
- Output: `dist/` (ESM, `type: "module"`), declarations, source maps
- 120 tests: mock-server pattern (MSW or respx-style intercepts), covers happy paths + error paths per resource

### CI coverage

The root `package.json` wires `clients/**` into `build`, `lint`, `typecheck`, `test`, and `test:coverage`. SDK tests run in CI. What does NOT run in CI: `codegen:check`. There is no step verifying the generated types match the spec.

---

## 8. Functional Status

| Dimension | Status |
|-----------|--------|
| Tests | 120 / 120 passing |
| Typecheck | Clean |
| Codegen sync | **Stale** — 479 line drift from current spec |
| CI gate on codegen sync | **Missing** |
| Internal consumers | None |
| npm publication | Blocked (`private: true`, R-10) |

---

## 9. Production Readiness

**Score: 6 / 10**

The SDK is well-engineered — broad coverage, 120 tests, strict types. The gaps are operational:

| Dimension | Assessment |
|-----------|-----------|
| Code quality | High — 120 tests, typecheck clean |
| Spec sync | Medium risk — 27 hunks of drift, one response-type divergence |
| CI enforcement | Missing `codegen:check` in pipeline |
| Internal adoption | Zero — e2e tests use a handwritten client |
| External availability | Not published (private) |

The SDK will not be useful to external integrators (Series A proof-point requirement) until it is published and the codegen drift is resolved. The e2e test suite not using the SDK means drift goes undetected until it breaks an external caller.

---

## 10. Confidence

| Area | Confidence | Reason |
|------|-----------|--------|
| Test results | High | Ran `pnpm -C clients/sdk run test` directly |
| Codegen drift | High | `codegen:check` ran, diff measured |
| Nature of drift | Medium | Diff examined; docstring/deprecation dominant; one type-level change noted |
| Zero internal consumers | High | grep across services/, tests/ — zero hits |
| CI gate absent | High | Confirmed by reading pr.yml and package.json root scripts |

---

## 11. Findings

### F-13-A — `codegen:check` not wired into CI (SEVERITY: Medium)

- **File**: `.github/workflows/pr.yml`, `package.json:21–25`
- **Evidence**: `codegen:check` is defined in `clients/sdk/package.json` but is not invoked by the root CI pipeline (no reference in pr.yml or main.yml). Drift is confirmed at 479 lines / 27 hunks.
- **Fix**: Add `pnpm -C clients/sdk run codegen:check` to the `typescript` job in `pr.yml` before the `build` step.

### F-13-B — `listAgents` response type richer in committed types than current spec (SEVERITY: Low)

- **Evidence**: `diff` shows committed `openapi.d.ts` includes `agents?: components["schemas"]["Agent"][]` in the `listAgents` response; fresh generation from current spec does not. If the server response omits `agents` at the root level (returning it under a different key), callers typing against the SDK will see `agents` but find it undefined at runtime.
- **Fix**: Regenerate (`pnpm -C clients/sdk run codegen`), review the diff, update any callers.

### F-13-C — Zero internal consumers means drift is invisible (SEVERITY: Low)

- **Evidence**: `@brain/sdk` is imported by no service, test, or script. The e2e suite uses a handwritten client.
- **Fix**: Use `@brain/sdk` in at least the e2e tests. This makes codegen drift immediately visible as a type error in CI, removing the need for `codegen:check` as a separate gate.

---

## 12. Cross-Cutting Risks Updated

| ID | Update |
|----|--------|
| R-10 | **Confirmed**: `@brain/sdk` is `private: true`, not published to npm. Zero internal consumers. |

No new risk register entries.

---

## 13. Recommended Next Steps

| Priority | Action |
|----------|--------|
| P0 | Add `pnpm -C clients/sdk run codegen:check` to `pr.yml` CI pipeline |
| P1 | Regenerate `openapi.d.ts` from current spec (`pnpm -C clients/sdk run codegen`), review type changes, update SDK resource classes if response shapes changed |
| P1 | Use `@brain/sdk` in `tests/e2e/` instead of the handwritten `BrainClient` — makes codegen drift a CI-breaking change |
| P2 | Set `private: false`, add a `prepublishOnly` script (`build && codegen:check`), publish `0.1.0-rc.0` to npm before Series A demos |
