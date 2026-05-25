# SDK Gap Against `main`

| Field                  | Value                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| Snapshot date          | 2026-05-25                                                                 |
| `main` HEAD            | `c07e027` — feat(sdk): add local environment and demo server factory (#12) |
| SDK package            | `@brain/sdk@0.1.0-rc.0` (not yet published to npm)                         |
| Surface inspected      | `clients/sdk/src/index.ts` at `main@c07e027`                               |
| OpenAPI surface        | `Brain_API_Specification.yaml` (79 path entries)                           |
| Architecture reference | `Brain_MVP_Architecture.md` v0.4                                           |
| Reconciled feat branch | `feat/sdk-local-integration` merged in #12 (2026-05-25)                    |

The SDK on `main` is far more complete than its README's slice table implies; this doc enumerates only the **real** gaps, not the README's already-shipped slices.

---

## 1. Wired on `main` (confirmed by reading the resource files, not just the README)

These do not need follow-up — listed here only as a sanity backstop.

- **Ledger reads** — `accounts`, `transactions`, `counterparties`, `obligations`, `invoices`, `balances`.
- **Audit + proof** — `audit.list/get/history/export/verify`, `audit.anchor.latest`, `proofs.get`, top-level `brain.proof(actionId)`.
- **Agent runs (H-25)** — `agentRuns.get/why/evidence/gateTrace/proof`.
- **Payments (full lifecycle incl. v0.4 additions)** — `payments.create/get/approve/reject/execute/pause/resume/replayInvestigation`, top-level `pay/approve/reject`.
- **Actions** — `actions.propose/execute/approve/escalate/get`.
- **Agents + routing (H-25 router surface)** — `agents.list/get/register/listActions/propose/route/run/enqueueEvent/listRuns/getRun/why/getRoutingDecision/halt/haltCategory`.
- **Raw** — `raw.ingest/get/getParsed`.
- **Wiki** — `wiki.question/search/getEntity/getEvidence/getHistory/annotate/schema` + `ask` compound.
- **Policy (incl. H-18 tooling)** — `policy.get/listVersions/compose/sign/activate/evaluate/simulate/lint/diff/simulateHistorical`.
- **Compounds** — `snapshot`, `trace`, `cashFlow.summarize`.

---

## 2. Newly landed on `main` via PR #12

Merged 2026-05-25 in `c07e027`. Added to the SDK in this reconciliation step:

- `BRAIN_BASE_URLS["local"] = "http://localhost:3000/v1"` and `BrainOptions.environment` widened to include `"local"`.
- `Brain.local(token, options?)` — one-liner factory for local dev.
- `Brain.fromDemoServer(baseUrl?, options?)` — zero-config factory; calls `GET /demo/token` (mounted at `services/api/src/main.ts:1098`).

---

## 3. Backend on `main`, **not** wired in the SDK

For each: backend artifact · OpenAPI path · suggested SDK shape · note on whether this is intentional.

### 3.1 Webhook dead-letter / replay (H-20)

- **Backend**: `services/audit/src/webhook-routes.ts`, `services/audit/src/webhooks.ts`, `shared/src/webhooks/{dead-letters,outbound,deliver}.ts`; migration `services/audit/migrations/0005_webhook_dead_letters.sql`.
- **OpenAPI**: `GET /webhooks/{endpoint_id}/dead-letters`, `POST /webhooks/{endpoint_id}/replay`.
- **SDK shape**: `brain.webhooks.deadLetters(endpointId)` and `brain.webhooks.replay(endpointId, ids?)` — no resource exists.
- **Intentional?** Probably no — H-20 is customer-visible. Operators need to inspect and replay failures from a typed client. Recommend wiring.

### 3.2 Ledger ops endpoints (normalize / reconcile / reconciliation-matches)

- **Backend**: `services/ledger/src/workers/normalizeWorker.ts`, `services/ledger/src/reconciliation/ReconciliationService.ts`.
- **OpenAPI**: `POST /ledger/normalize`, `POST /ledger/reconcile`, `GET /ledger/reconciliation-matches`.
- **SDK shape**: extend the ledger resources or add `brain.ledger.{normalize,reconcile,reconciliationMatches}`. The reads (`reconciliation-matches`) belong in the SDK; the writes (`normalize`, `reconcile`) are likely admin/cron-triggered and may be intentionally absent.
- **Intentional?** Mixed. The read is a real gap — reconciliation results are not currently inspectable from the typed client. Recommend wiring `reconciliationMatches` at minimum.

### 3.3 Memory pages (`/memory/*`)

- **OpenAPI**: `GET/POST /memory/pages`, `GET /memory/pages/{slug_or_id}`, `POST /memory/regenerate`, `GET /memory/search`.
- **SDK shape**: none.
- **Intentional?** Likely. `/memory/*` is the v0.2 page-generation surface that v0.3 split into `/wiki/*` (already wired). Verify whether `/memory/*` is still live or carries deprecation headers — if live, decide whether to expose; if deprecated, document and leave unexposed.

### 3.4 Legacy `/execution/*` surface (v0.2 backwards-compat)

- **OpenAPI**: `POST /execution/propose`, `/execution/execute`, `GET /execution/{execution_id}`, `POST /execution/approve`, `/execution/escalate`, `/execution/agents`, `/execution/agents/register`, `GET /execution/agents/{agent_id}`.
- **SDK shape**: none.
- **Intentional?** Yes. v0.4 explicitly retains `/execution/*` for v0.2 callers with deprecation headers; the SDK should target `/agents/*` and `/payment-intents/*` (it does). No action.

### 3.5 MCP JSON-RPC surface (`POST /agents/mcp`)

- **OpenAPI**: `POST /agents/mcp`.
- **SDK shape**: none.
- **Intentional?** Yes. MCP is for external-agent runtimes (Anthropic/OpenAI clients) connecting via JSON-RPC, not for `@brain/sdk` consumers. No action.

### 3.6 Raw webhooks ingress

- **OpenAPI**: `POST /raw/webhooks/{provider}`.
- **SDK shape**: none.
- **Intentional?** Yes. HMAC-signed provider ingress (Plaid, NetSuite, Gmail), not a JWT-bearer SDK call. No action.

### 3.7 `GET /demo/token`

- **Backend**: `services/api/src/main.ts:1098`.
- **OpenAPI**: not currently advertised in the spec (verify); `Brain.fromDemoServer` (feat / PR #12) calls it directly via `fetch`.
- **SDK shape**: PR #12 covers this idiomatically (`Brain.fromDemoServer()`). If the route is intended to remain stable, add it to `Brain_API_Specification.yaml` so it's part of the contract.

### 3.8 Stale `Brain` class JSDoc

- **File**: `clients/sdk/src/brain.ts` lines 63–70.
- **Issue**: comment says _"Slices 1B.1 (ledger), 1B.2 (audit), 1B.3 (payment intents + actions) are shipped. Agents, raw/sources, wiki, policy, and client-side compounds follow in subsequent PRs."_ — but all those slices are now shipped on `main` (1B.4–1B.8 in the README). The comment misleads readers about coverage.
- **Recommendation**: replace the JSDoc with a one-liner pointing to `clients/sdk/README.md`'s slice table, or drop it entirely.

### 3.9 Stale README slice 1B.7 marker

- **File**: `clients/sdk/README.md`, line ~26.
- **Issue**: row 1B.7 reads _"shipping in this PR"_, but the compounds (`snapshot`, `trace`, `cashFlow.summarize`) are present in `clients/sdk/src/resources/compounds.ts` and `index.ts`. The marker is from a long-merged PR.
- **Recommendation**: flip the status to "shipped".

### 3.10 Internal-agent catalog discoverability

- **Backend**: `services/internal-agents/` (`@brain/internal-agents`) ships 20 agent definitions (`bill_management`, `cash_forecast`, `collections`, `compliance`, `debt_optimization`, `dispute`, `financial_health`, `fraud_anomaly`, `payment`, `personal_budget`, `purchase_advisor`, `reconciliation`, `revenue_intel`, `savings`, `subscription`, `tax_prep`, `travel_finance`, `treasury`, `vendor_risk`). Bootstrap script: `scripts/register-internal-agents.ts`.
- **OpenAPI**: covered by `GET /agents` and `GET /agents/{agent_id}` — wired via `AgentsResource.list/get`.
- **SDK shape today**: callers receive agent records by string id but the SDK does not expose a typed enum / constant of the canonical 20 ids, so an autocomplete user has to read the architecture doc to discover names.
- **Recommendation**: export `INTERNAL_AGENT_IDS` (`as const` string-literal union) from `@brain/sdk` so consumers can `import { INTERNAL_AGENT_IDS } from "@brain/sdk"`. Generate from `services/internal-agents/src/*/definition.ts` at codegen time so it stays in sync.

### 3.11 16-check §6 gate trace type fidelity

- **Backend**: `shared/src/gate/{gate,snapshot,duplicate,evidence-validator}.ts`; the gate now persists checks **7.5** (ledger-state snapshot bind, H-08), **9.5** (evidence semantic validation, H-21), **11.5** (duplicate-payment guard, H-22) into the `gate_checks` snapshot.
- **SDK shape today**: `ProofGateCheck` type (from `clients/sdk/src/resources/proof.ts`) is sourced from the generated OpenAPI. Need to confirm the schema for `gate_checks` is enumerated to the full 16-entry set on the OpenAPI side, otherwise SDK consumers may see `unknown` strings for the v0.4 sub-checks.
- **Recommendation**: codegen check; if `Brain_API_Specification.yaml` doesn't enumerate the 16 check codes, add them so the SDK's union type is exhaustive.

### 3.12 Agent capability manifest (H-15) / AgentOutput contract (H-16)

- **Backend**: `services/internal-agents/src/registration.ts`, `shared/src/agents/capability.ts`, `shared/src/contracts/agent-output.ts`, schemas `schemas/agent-manifest.{ts,schema.json}` and `schemas/agent-definition.{ts,schema.json}`.
- **SDK shape today**: `Agent` type is OpenAPI-generated; whether it surfaces `capability_manifest` and `agent_output_contract` fields depends on the spec. Likely OK but verify.
- **Recommendation**: in a follow-up, smoke-check `AgentsResource.get` against an agent registered via `scripts/register-internal-agents.ts` and confirm both fields round-trip.

### 3.13 Promotion / promotion-readiness (H-24)

- **Backend**: `services/agent-router/src/promotion{,-config}.ts`, `scripts/check-promotion-readiness.mjs`.
- **SDK shape**: none.
- **Intentional?** Yes — promotion is an ops-/CI-time gate, not a consumer surface. No action.

### 3.14 Domain event bus (H-17)

- **Backend**: `shared/src/events/{bus,triggers,types}.ts`; Postgres LISTEN/NOTIFY; migration `services/audit/migrations/0006_domain_events.sql`.
- **SDK shape**: none.
- **Intentional?** Yes — server-internal. No action.

---

## 4. Suggested follow-up PRs (prioritized)

1. **Wire webhooks dead-letters + replay** — H-20 customer surface. New `WebhooksResource` in `clients/sdk/src/resources/webhooks.ts`. _(section 3.1)_
2. **Wire `brain.ledger.reconciliationMatches.list`** — reconciliation results are currently inaccessible from the typed client. _(section 3.2)_
3. **Export `INTERNAL_AGENT_IDS` constant** from `@brain/sdk`, generated from `services/internal-agents/src/*/definition.ts`. _(section 3.10)_
4. **Refresh stale docs/JSDoc** — `clients/sdk/src/brain.ts:63–70` and `clients/sdk/README.md` status row 1B.7. _(sections 3.8, 3.9)_
5. **OpenAPI enumeration of the 16 gate-check codes** + codegen check to verify SDK `ProofGateCheck` union is exhaustive. _(section 3.11)_
6. **Decide `/memory/*` future** — document deprecation + leave unwired, or expose. _(section 3.3)_
7. **Add `/demo/token` to OpenAPI spec** so `Brain.fromDemoServer` is contract-backed instead of relying on an undocumented route. _(section 3.7)_

Sections 3.4, 3.5, 3.6, 3.13, 3.14 are intentionally not wired — no action required.

---

## 5. How this was assembled

- Diff base: `git merge-base feat/sdk-local-integration 3c781f3c` (= `4c9876d`, May 22).
- Main divergence: 86 commits / 400 files / +27,467 / −1,369.
- SDK resources inventoried by reading every file under `clients/sdk/src/resources/` on `main@3c781f3` and listing public methods.
- OpenAPI path list extracted with `grep -E "^  /[a-z]" Brain_API_Specification.yaml` (79 path entries) and intersected against the wired SDK methods.
- Architecture cross-reference: `Brain_MVP_Architecture.md` v0.4 (in particular the H-XX hardening tags surfaced in `git log` since `4c9876d`).

## 6. Note on `main` CI at snapshot time

At the time of this snapshot, `main`'s own CI is failing (red) at HEAD due to a pre-existing build error in `services/api/src/proof/routes.ts:14` and `services/api/src/policy/viemPolicySignerChecker.ts:3` — three workspace cross-references (`@brain/wiki.renderProofExplanation`, `@brain/audit`, `@brain/policy`) that `services/audit`, `services/raw`, and `services/policy` cannot resolve when they `tsc -b`. PR #12 was admin-merged because (a) its diff was confined to `clients/sdk/src/brain.{ts,test.ts}` and passes typecheck + 120/120 unit tests in isolation, and (b) reproducing the failure on plain `main` (no PR diff applied) shows the same errors. Fixing those imports is **not** an SDK concern and is tracked separately for the owning author.
