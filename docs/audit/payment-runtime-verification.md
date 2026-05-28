# Payment Runtime Verification Audit

**Branch:** `main` (HEAD `bfbbcd4`)  
**Date:** 2026-05-27  
**Scope:** Payment execution path. Agent promotion, rail dispatch, fail-closed behaviour.  
**Method:** Static code trace + controlled runtime probes against a live local stack (pg/redis + brain-server).

---

## Executive Summary

| Question                                         | Answer                                                                                                                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can any agent move money right now?              | **No.** All execution paths fail before money leaves the system. Evidence below.                                                                                                                                                  |
| Can the payment agent directly execute?          | **No.** Execute requires a separate HTTP call + `payment_intent:execute` scope. The agent only proposes.                                                                                                                          |
| Does the on-chain rail work?                     | **No. Not operational.** `BRAIN_SESSION_KEY` is absent from the local `.env`; no `X402Client` implementation exists for x402.                                                                                                    |
| Does the Plaid transfer rail work?               | **No. Not operational.** Rail IS registered (from `.env` Plaid creds), but dispatch fails: no source credential (Plaid access_token) mapped to any demo account, and `Products.Transfer` was never requested at Plaid link time. |
| Does the system fail closed without credentials? | **Yes, with caveats.** Stub rails throw in `NODE_ENV=production`. But the `BRAIN_DEMO_MODE=true` flag in `.env` prevents the server from starting in production at all.                                                           |

**The system is a proposal-only system in its current deployment state.** No real money can move.

**New findings not in prior audits:**

1. The `.env` auto-loader (`main.ts:188-200`, Node 20 `loadEnvFile`) silently wires AchPlaidRail from `.env` Plaid credentials. The stub "no real rails configured" fallback does NOT apply on this machine.
2. The `POST /agents/events` → BullMQ `routeAndPropose` path bypasses the `LIVE_AGENTS` shadow gate. A shadowed treasury agent created a real `PaymentIntent` row during testing. The Policy layer (second defence) rejected it.
3. `x402_settle` is blocked at three independent layers: HTTP `ACTION_TYPES`, MCP `ACTION_TYPES`, and a Postgres CHECK CONSTRAINT on `ledger_payment_intents`.

---

## Runtime Capability Matrix

| Capability                                   | Code Exists | Runtime Works       | Evidence                                                                                               |
| -------------------------------------------- | ----------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| Payment proposal (HTTP)                      | ✓           | ✓                   | `POST /payment-intents` created `pi_01KSKVN2EN7STY9BKSW2K52GDX`                                        |
| Payment proposal (MCP)                       | ✓           | ✓ (auth-gated)      | `payment_intent.propose` tool, `payment-intent.ts:93`                                                  |
| Payment proposal (BullMQ worker)             | ✓           | ✓ (no shadow check) | Treasury bypassed gate; `pi_01KSKWABH6RPA6YECTMM7PXTRG` created                                        |
| Shadow gate (LIVE_AGENTS) on `/agents/run`   | ✓           | ✓                   | `agent-run-service.ts:223-262` enforced                                                                |
| Shadow gate on `/agents/events` / BullMQ     | ✗           |.                   | `worker.ts:125` calls `proposeAction` without `isShadowed`                                             |
| Execute requires approval                    | ✓           | ✓                   | Probe: status check at `PaymentIntentService.ts:509-513`                                               |
| Execute via MCP                              | ✗           |.                   | Locked by `registry.no-execute.test.ts:22`                                                             |
| ACH Plaid rail registered                    | ✓           | ✓ (registered)      | Boot log: "ACH Plaid rail registered" from `.env` creds                                                |
| ACH Plaid rail dispatches money              | ✓ (code)    | ✗                   | Probe: `last_error = "ACH action requires a string access_token"`                                      |
| On-chain rail (`OnchainBaseRail`) registered | ✓           | ✗                   | `BRAIN_SESSION_KEY` absent from `.env` → rail not registered                                           |
| On-chain rail dispatches (`writeContract`)   | ✓ (code)    | ✗                   | `onchainExecutor.ts:47` exists but unreachable without key                                             |
| x402 rail (`X402BaseRail`) registered        | ✓ (code)    | ✗                   | No `new X402BaseRail` anywhere in boot; `X402Client` interface has no concrete impl                    |
| x402_settle action type accepted             | ✗           | ✗                   | DB CHECK CONSTRAINT blocks it; HTTP + MCP ACTION_TYPES also reject it                                  |
| Stub rails in production                     | ✗           |.                   | `assertStubRailsAllowed()` at `stubs.ts:24-30` throws                                                  |
| Policy evaluation before execute             | ✓           | ✓                   | Probe: treasury PI `rejected` by policy before it could reach execute                                  |
| §6 gate blocks unqualified execute           | ✓           | ✓                   | `PaymentIntentService.execute:519`, 13 checks + 4 hardening additions                                  |
| Plaid `Products.Transfer` configured         | ✗           | ✗                   | Only `Products.Transactions` in `tools/plaid-sandbox/src/index.ts:81`; no `Products.Transfer` anywhere |

---

## Full Execution Trace

The complete path from agent proposal to potential rail dispatch:

```
[Internal agent or external MCP call]
         │
         ▼
POST /payment-intents  (routes.ts:76)
  OR POST /agents/run  (agent-api.ts:164)
  OR POST /agents/events → BullMQ  (agent-api.ts:171)
         │
         ▼ ← SHADOW GATE (only on /agents/run path via AgentRunService)
         │   agent-run-service.ts:223-262
         │   • checks LIVE_AGENTS (promotion-config.ts:22-26)
         │   • non-payment agents → shadow_completed (terminal, no PI created)
         │   • payment agent + non-allowlisted rail → rail_not_allowlisted
         │
         ▼
PaymentIntentService.create()  (PaymentIntentService.ts:144)
  • evaluates Policy → PolicyDecision
  • status = proposed | pending_approval | approved | rejected
         │
         ▼ [if approved and execute called]
         │
POST /payment-intents/:id/execute  (routes.ts:189-201)
  requireScope(SCOPE_EXECUTE = "payment_intent:execute")
         │
         ▼
PaymentIntentService.execute()  (PaymentIntentService.ts:507)
  • asserts status === "approved"  (L509-513)
  • runs §6 pre-execution gate  (L519). 13 checks + 4 hardening additions
  • if gate ok: approved → dispatching transition (atomic with outbox enqueue)
         │
         ▼
OutboxService.enqueue()  (OutboxService.ts, within same DB tx as transition)
         │
         ▼
OutboxWorker.runOutboxCycle()  (worker.ts:92-114)  [polls every 1000ms]
  • claimNext (FOR UPDATE SKIP LOCKED)
  • processClaimedRow → rail.dispatch(input)
         │
         ▼
RailRegistry.get(railName)  (stubs.ts:90-96)
  • railFor() maps: ach_outbound/ach_inbound/wire/card_payment → "bank_ach"
                   onchain_transfer → "onchain_base"
                   x402_settle → "x402_base"  [unreachable. See below]
  • if rail not registered: throws execution_rail_unavailable
         │
         ▼
rail.dispatch(input)
  AchPlaidRail: parseAchAction → needs access_token in payload
    → FAILS: "ACH action requires a string access_token" (no Plaid item linked)
  OnchainBaseRail: NOT REGISTERED (BRAIN_SESSION_KEY absent)
  X402BaseRail: NOT REGISTERED (no boot wiring, no X402Client impl)
         │
         ▼
  on dispatch failure: outbox.markFailed() → attempt_count++
  if attempt_count >= MAX_DISPATCH_ATTEMPTS (3): row moves to "reconciling"
  (reconciling rows are retried indefinitely)
```

**Runtime evidence**: `pi_01KSKVN2EN7STY9BKSW2K52GDX` (ach_outbound) reached `dispatching`; outbox row `exo_01KSKVNCPSP44Y5T6C3TCEKT2Q` reached `reconciling` with `attempt_count=49`, `last_error="ACH action requires a string access_token"`.

---

## On-Chain Rail Findings

### What is registered

**`OnchainBaseRail`** registers at boot ONLY when both `BRAIN_SESSION_KEY` AND `BASE_RPC_URL` are set (`main.ts:899-906`):

```typescript
// services/api/src/main.ts:899-906
if (cfg.BRAIN_SESSION_KEY !== undefined && cfg.BASE_RPC_URL !== undefined) {
  const executor = buildOnchainExecutor({
    privateKey: cfg.BRAIN_SESSION_KEY as `0x${string}`,
    rpcUrl: cfg.BASE_RPC_URL,
    chainId: cfg.BRAIN_BASE_CHAIN_ID,
  });
  configured.push(new OnchainBaseRail({ executor }));
}
```

The local `.env` has `BRAIN_SESSION_KEY` commented out. `OnchainBaseRail` is NOT registered.

### What the rail actually does (when registered)

`services/api/src/rails/onchainExecutor.ts:27-61`. **real implementation, no stubs**:

- `privateKeyToAccount(BRAIN_SESSION_KEY)`. Raw EOA private key, NOT Azure Key Vault
- `createWalletClient({account, chain, transport: http(rpcUrl)})`
- `walletClient.writeContract({...BrainSmartAccount.executeViaSessionKey...})`
- `publicClient.waitForTransactionReceipt({hash})`

**This IS a live on-chain broadcast path.** If `BRAIN_SESSION_KEY` and `BASE_RPC_URL` are set, `OnchainBaseRail.dispatch()` will send a real transaction.

### Azure Key Vault gap

The file header (`onchainExecutor.ts:1-9`) says "Production signs via Azure Key Vault (`BRAIN_AZURE_KEY_VAULT_URL`)... Never set `BRAIN_SESSION_KEY` in production." However, the executor only implements the `privateKeyToAccount` path. No Key Vault adapter exists in the codebase. Zero matches for `@azure/keyvault-keys`, `DefaultAzureCredential`, or `KeyVaultSigner` in `services/api/src/`.

**State**: On-chain rail is present and operational IF given a raw private key. Production Key Vault path is documented but unimplemented.

### x402 rail (NEW in v0.4. PRs #34–#38)

`X402BaseRail` (`services/execution/src/rails/x402-base.ts`) has the rail's logical shape but:

- `X402Client` interface (`x402-base.ts:48-50`) has NO concrete implementation in the repo
- Zero `new X402BaseRail(...)` calls in `services/api/src/main.ts`. Rail is never registered
- `x402_settle` action type blocked at **three independent layers**:
  1. HTTP route `ACTION_TYPES` set (`routes.ts:62-69`). Rejects it with `request_body_invalid`
  2. MCP tool `ACTION_TYPES` set (`payment-intent.ts:35-42`). Same rejection
  3. Postgres CHECK CONSTRAINT on `ledger_payment_intents.action_type`. Only allows `{ach_outbound, ach_inbound, wire, onchain_transfer, erp_writeback, card_payment, other}`
- Runtime insert of `x402_settle` row was attempted and **failed**: `ERROR: new row for relation "ledger_payment_intents" violates check constraint "ledger_payment_intents_action_type_check"`

**Verdict**: x402 rail is architecturally sketched but operationally dead. It cannot be invoked from any reachable code path.

---

## Plaid Rail Findings

### Rail registration

`AchPlaidRail` registers when `PLAID_CLIENT_ID` AND `PLAID_SECRET` are set (`main.ts:890-897`). The local `.env` sets both. **The rail IS registered on this machine.** Boot log confirmed: `"ACH Plaid rail registered"`.

The `plaid` SDK client (`services/api/src/rails/plaidClient.ts:24-48`) calls:

- `api.transferAuthorizationCreate(...)`. Real Plaid Transfer API
- `api.transferCreate(...)`. Real Plaid Transfer API

### Dispatch failure. Source credential missing

The execute path resolves Plaid credentials from `sourceCredentialResolver` (`main.ts:854-868`) into the outbox payload. The demo seed data (`tools/seed-golden-path/src/index.ts`) writes no Plaid-linked items (`raw_plaid_items`) and no source credentials. The resolver returns `null`; `access_token` is never set in the payload.

The rail's `parseAchAction()` (`ach-plaid.ts:88-92`) then throws:

```
validation_failed: "ACH action requires a string access_token"
```

**Runtime evidence** (queried from `execution_outbox`):

```
id                              rail      status       attempt_count  last_error
exo_01KSKVNCPSP44Y5T6C3TCEKT2Q  bank_ach  reconciling  49             ACH action requires a string access_token
```

### Plaid product scope gap

The Plaid link flow (`tools/plaid-sandbox/src/index.ts:81`) requests only:

```typescript
initial_products: [Products.Transactions];
```

`Products.Transfer` does NOT appear anywhere in the codebase. The Plaid item linked at onboarding has no Transfer product enabled. Even if source credentials existed, `transferAuthorizationCreate` would fail because the item was not linked with `transfer` product.

**Grep confirmation** (exhaustive):

```
tools/plaid-sandbox/src/index.ts:81:    initial_products: [Products.Transactions],
```

Zero other `Products.*` references in `services/`, `tools/`, or `shared/`.

### Sandbox validation

No `BRAIN_PLAID_SANDBOX_INTEGRATION=1` is set, and the integration test is blocked by default (`.env.example:63-64`). No sandbox round-trip has been verified.

**Verdict**: Plaid Transfer rail is implemented against the real Plaid SDK, but two independent barriers prevent money movement: (1) no source credentials in demo accounts, (2) `Products.Transfer` never requested at link time.

---

## Fail-Closed Analysis

### Stub rail guard (`NODE_ENV=production`)

`services/execution/src/rails/stubs.ts:24-30`:

```typescript
function assertStubRailsAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "stub payment rails cannot settle money in NODE_ENV=production; configure real ACH/ERP/on-chain rails before deploying",
    );
  }
}
```

Called at every stub dispatch AND at `defaultRails()` factory. A production deployment without real rail credentials cannot even construct the rail registry.

### Demo mode production fence

`services/api/src/main.ts:597-598`:

```typescript
if (cfg.BRAIN_DEMO_MODE && cfg.NODE_ENV === "production") {
  throw new Error("BRAIN_DEMO_MODE=true is not allowed in NODE_ENV=production");
}
```

**Runtime evidence**: Boot with `NODE_ENV=production` (no explicit `BRAIN_DEMO_MODE` override) fails immediately:

```
Error: BRAIN_DEMO_MODE=true is not allowed in NODE_ENV=production
```

This is because the `.env` auto-loader sets `BRAIN_DEMO_MODE=true` before the zod config parses. The local deployment **cannot start in production mode** at all with the current `.env`.

### Additional fences (`main.ts:597-605`)

```typescript
if (cfg.BRAIN_MCP_DEV_AUTH_BYPASS && cfg.NODE_ENV === "production")
  throw "BRAIN_MCP_DEV_AUTH_BYPASS=true is not allowed in NODE_ENV=production";
if (cfg.BLOB_BACKEND === "memory" && cfg.NODE_ENV === "production")
  throw "BLOB_BACKEND=memory is not allowed in NODE_ENV=production";
```

**Can accidental settlement happen without credentials?** No. The safety chain is:

1. Without Plaid creds + `NODE_ENV=production` → `defaultRails()` throws before server listens
2. With `BRAIN_DEMO_MODE=true` + `NODE_ENV=production` → boot throws before rails are reached
3. Stub rail dispatch in production → throws even if somehow constructed

**Caveat**: No `STUB_RAILS_ENABLED` flag exists. The only switch is `NODE_ENV`. A misconfigured deployment (real creds + `NODE_ENV=development`) could execute ACH or on-chain transfers against real rails. The `.env` comment documents this: `PLAID_ENV=sandbox` is the only "staging" guard for Plaid.

---

## Shadow Gate Analysis. Claim 1 Nuance

### On the `AgentRunService` path (`POST /agents/run`)

`agent-run-service.ts:223-262` enforces LIVE_AGENTS. Shadow gate is solid:

- Non-payment agents → `shadow_completed` (terminal)
- Payment agent + non-allowlisted rail → `rail_not_allowlisted`
- No PaymentIntent created on shadow path

### Bypass via `POST /agents/events` → BullMQ

`worker.ts:61-133` (`routeAndPropose`) has NO shadow check. The BullMQ worker calls `proposeAction()` directly.

**Bypass requires** (all verified):

1. `execution:propose` scope (demo token has it)
2. `POST /agents/events` with a domain event
3. `context.requested_action` set to a financial action (e.g., `propose_transfer`)
4. Required context fields (source_account_id, destination_counterparty_id, amount, currency)

**Runtime evidence**. Treasury agent (SHADOWED) created a real PaymentIntent:

```
POST /agents/events
  event: "cash.balance_high"
  context: { requested_action: "propose_transfer", source_account_id: "acct_...", ... }

Result: pi_01KSKWABH6RPA6YECTMM7PXTRG
  action_type: onchain_transfer
  status: rejected  ← Policy second defence caught it
  created_by_agent_id: agent_router_worker
```

**What stopped money movement**: The Policy engine evaluated the intent and returned `reject` (no valid policy template for agent_router_worker / treasury). Status never reached `approved`, so `execute` could never be called.

### Direct HTTP `/payment-intents` bypass

`routes.ts:76` (with `payment_intent:propose` scope) creates a PaymentIntent directly, bypassing LIVE_AGENTS entirely. This is the primary user-facing propose path and is intentionally not shadow-gated (LIVE_AGENTS gates internal agent routing, not human operators).

### MCP tool bypass

`payment-intent.ts:93` creates intents for any MCP-registered external agent with `payment_intent:propose` scope. The gate for MCP agents is the on-chain `BrainMCPAgentRegistry` membership check, not `LIVE_AGENTS`.

---

## Final Verdict

### Classification

**The system is currently in "Proposal-capable, Execution-disabled" state.** More precisely, a compound of:

- **Proposal path**: fully operational for humans (HTTP), partially operational for agents (MCP, with on-chain auth), and operational-with-bypass for internal agents (BullMQ path skips LIVE_AGENTS)
- **Policy + §6 gate**: operational and serves as second defence when shadow gate is bypassed
- **ACH rail**: registered from `.env` credentials but execution-disabled (no source credentials, wrong Plaid products)
- **On-chain rail**: unregistered (BRAIN_SESSION_KEY absent), code operational if key supplied
- **x402 rail**: architecturally dead (three independent blockers, no X402Client impl)
- **ERP rail**: stub-only, always fails in production

### Code vs Operational Reality Table

| Area                                | Exists In Code | Operational In Runtime                              |
| ----------------------------------- | -------------- | --------------------------------------------------- |
| Payment proposal                    | ✓              | ✓                                                   |
| Payment execution                   | ✓              | ✗. Fails at rail dispatch                          |
| On-chain transfer (OnchainBaseRail) | ✓              | ✗. Key absent from `.env`                          |
| Plaid ACH transfer                  | ✓              | ✗. No source creds, wrong Plaid products           |
| x402 settlement                     | ✓ (shape only) | ✗. No client, DB constraint blocks intent creation |
| Approval gates                      | ✓              | ✓                                                   |
| Policy evaluation                   | ✓              | ✓                                                   |
| §6 pre-execution gate               | ✓              | ✓                                                   |
| Shadow gate on `/agents/run`        | ✓              | ✓                                                   |
| Shadow gate on `/agents/events`     | ✗              |.                                                   |
| ACH settlement (webhook)            | ✓              | ✗. Never reached                                   |
| On-chain Key Vault signing          | ✗              | ✗. Documented but unimplemented                    |

---

## Appendix A: Key Evidence Index

| Finding                          | File                                                             | Lines   | Runtime Evidence                   |
| -------------------------------- | ---------------------------------------------------------------- | ------- | ---------------------------------- |
| LIVE_AGENTS definition           | `services/agent-router/src/promotion-config.ts`                  | 22–26   |.                                  |
| Shadow gate enforcement          | `services/agent-router/src/agent-run-service.ts`                 | 223–262 |.                                  |
| BullMQ worker no shadow check    | `services/agent-router/src/worker.ts`                            | 61–133  | Treasury PI created                |
| execute() approval gate          | `services/execution/src/payment-intents/PaymentIntentService.ts` | 507–514 |.                                  |
| MCP no-execute lock              | `services/mcp/src/tools/registry.no-execute.test.ts`             | 22      |.                                  |
| Rail boot registration           | `services/api/src/main.ts`                                       | 888–913 | Boot log shows Plaid registered    |
| Stub rail production fence       | `services/execution/src/rails/stubs.ts`                          | 24–30   |.                                  |
| .env auto-loader                 | `services/api/src/main.ts`                                       | 188–200 | Plaid creds loaded from `.env`     |
| DEMO_MODE prod fence             | `services/api/src/main.ts`                                       | 597–598 | Boot error captured                |
| x402 no concrete client          | `services/execution/src/rails/x402-base.ts`                      | 48–50   |.                                  |
| x402 DB constraint blocks        | DB CHECK CONSTRAINT                                              |.       | Insert failed                      |
| ACH dispatch failure             | `services/execution/src/rails/ach-plaid.ts`                      | 88–92   | `last_error` in `execution_outbox` |
| Plaid Products.Transactions only | `tools/plaid-sandbox/src/index.ts`                               | 81      | grep exhaustive                    |
| On-chain real broadcast          | `services/api/src/rails/onchainExecutor.ts`                      | 47–54   |. (key absent)                     |
| Azure Key Vault unimplemented    | `services/api/src/rails/onchainExecutor.ts`                      | 1–9     | comment only                       |

---

## Appendix B: Known Open Issues

1. **Shadow gate bypass via `POST /agents/events`**: Shadowed agents can create PaymentIntent rows (status will likely be `rejected` from Policy, but not guaranteed if policies are misconfigured). Mitigation: wire `isShadowed` check into `routeAndPropose` or gate the events endpoint by agent kind.

2. **`Products.Transfer` not requested at Plaid link time**: The `tools/plaid-sandbox/src/index.ts` link flow only requests `[Products.Transactions]`. AchPlaidRail will fail at `transferAuthorizationCreate` for any Plaid item linked via this flow. The Transfer product must be added to `initial_products` and the Plaid application must have Transfer enabled in the Plaid Dashboard.

3. **Azure Key Vault path unimplemented**: The on-chain rail can only sign with a raw private key (`BRAIN_SESSION_KEY`). Production requires an Azure Key Vault adapter that is documented but does not exist in the codebase.

4. **`DATABASE_PRIVILEGED_URL` unset**: The outbox worker falls back to `DATABASE_URL` (full RLS bypass warning). Cross-tenant claim isolation depends on this being set to `brain_privileged` role in production.

5. **Outbox retry storm**: A reconciling row (e.g., `exo_01KSKVNCPSP44Y5T6C3TCEKT2Q`) is re-picked indefinitely by the worker after MAX_DISPATCH_ATTEMPTS (3). The `reconciling` status is included in the `idx_execution_outbox_pending` index. After 49 attempts, the `ACH action requires a string access_token` error still fires every 1000ms.

6. **x402 `railFor()` dead branch**: `PaymentIntentService.ts:801-802` maps `x402_settle → x402_base`, but no intent with that action_type can ever exist (DB constraint). This mapping is dead code until x402_settle is added to the constraint and the X402Client is implemented.
