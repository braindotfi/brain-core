# Audit: MCP Runtime

**Audited:** 2026-05-26
**Files examined:**
- `services/mcp/src/auth.ts`
- `services/mcp/src/server.ts`
- `services/mcp/src/dispatcher.ts`
- `services/mcp/src/resources.ts`
- `services/mcp/src/prompts.ts`
- `services/mcp/src/transport/http.ts`
- `services/mcp/src/tools/registry.ts`
- `services/mcp/src/tools/ledger.ts`
- `services/mcp/src/tools/wiki.ts`
- `services/mcp/src/tools/raw.ts`
- `services/mcp/src/tools/payment-intent.ts`
- `services/mcp/src/tools/agent.ts`
- `services/mcp/src/tools/__snapshots__/registry.no-execute.test.ts.snap`
- `services/api/src/main.ts` (lines 1005–1041, 1325–1329)
- `services/mcp/package.json`
- `shared/src/contracts/ILedgerService.ts`

**Commands run:**
```
pnpm --filter @brain/mcp run typecheck
pnpm --filter @brain/mcp run test
grep -n "FROM agents WHERE" services/mcp/src/auth.ts
grep -n "mcpAuthVerifier|McpAuthVerifier" services/api/src/main.ts
grep -n "listObligations|limit.*1" services/mcp/src/resources.ts
grep -n "getObligation" shared/src/contracts/ILedgerService.ts
cat services/mcp/src/tools/__snapshots__/registry.no-execute.test.ts.snap
```

---

## 1. Scope

This report covers:
- `@brain/mcp` — JSON-RPC 2.0 MCP server: auth chain, all 10 tools, 5 resources, 5 prompts, dispatcher
- The cross-service DB access question flagged in the prior audit (`auth.ts` querying execution's `agents` table directly)
- Boot wiring in `services/api/src/main.ts` — whether all services are correctly injected
- The `obligation` resource correctness bug

Out of scope: the HTTP transport's Fastify plugin lifecycle (covered in `services/api.md`); R-16 (`wiki.annotate` 500 error, a service-layer issue not an MCP tool).

---

## 2. Intended Architecture

Per `CLAUDE.md`:

> Mount: `POST /v1/agents/mcp`, JSON-RPC 2.0, single-shot HTTP, no SSE/streaming, no session state (v0.3).
> Surface: 10 tools (ledger reads ×5, wiki reads ×2, `raw.contribute` ×1, propose-only payment/agent actions ×2), 5 resource URIs, 5 prompts.
> No `payment_intent.execute` tool, ever.
> Auth chain: Fastify JWT plugin → agent record `active` → JWT `scope_hash` matches on-chain `BrainMCPAgentRegistry` (60s cache, Base RPC fallback) → tool scope → tenant equality.
> Every successful tool/resource call emits `agent.mcp.tool_called`.

The server is designed to be stateless: agent identity is verified on every request, scope is enforced per-tool, and all state lives in injected service dependencies.

---

## 3. Actual Implementation

### Tool count — 10 confirmed

Registry snapshot (`tools/__snapshots__/registry.no-execute.test.ts.snap`):
```
agent.action.propose
ledger.account.get
ledger.accounts.list
ledger.counterparties.list
ledger.obligations.list
ledger.transactions.list
payment_intent.propose
raw.contribute
wiki.page.get
wiki.question
```

Breakdown matches the spec: ledger reads ×5, wiki reads ×2, `raw.contribute` ×1, `payment_intent.propose` ×1, `agent.action.propose` ×1 = 10. No `payment_intent.execute` tool exists; the snapshot test enforces this by freezing the tool list.

### Auth chain — all 4 checks implemented

`McpAuthVerifier.verify()` (`auth.ts:67–113`) checks in order:
1. `principal.type === "agent"` — rejects non-agent principals
2. Agent row exists in `agents` table and `state === "active"` — rejects unknown or inactive agents
3. `agent.tenant_id === principal.tenantId` — tenant equality (defense in depth)
4. `scope_hash` present → on-chain hash fetched from `BrainMCPAgentRegistry` (60s cached) → byte-level match

The 60s cache is per-`(agentId)` pair with a `clearCache()` method for operator rotation. A real on-chain mismatch throws `agent_scope_hash_mismatch` and the request is rejected.

`FakeAuthVerifier` is available for `BRAIN_MCP_DEV_AUTH_BYPASS=true && NODE_ENV !== "production"` — correctly blocked in production.

### Cross-service DB access — present but mitigated (R-3 revisited)

The prior audit flagged `auth.ts:117` as a cross-service DB access violation. The current code:

```ts
private async loadAgent(principal: Principal): Promise<AgentRecord | null> {
  return withTenantScope(this.pool, principal.tenantId, async (c) => {
    const { rows } = await c.query<AgentRecord>(
      `SELECT id, tenant_id, state, scope_hash, onchain_address, role
         FROM agents WHERE id = $1 LIMIT 1`,
      [principal.id],
    );
    return rows[0] ?? null;
  });
}
```

`@brain/mcp` takes the shared `pool` (from the composition root in `main.ts:1019`) and queries the `agents` table directly with `withTenantScope` (RLS active). The `agents` table is owned by `@brain/execution`. This is a genuine cross-service read that bypasses the owning service's API contract.

**Assessment:** This is an architectural violation per CLAUDE.md ("cross-service reads go through the owning service's API, never direct DB queries"). However, it is mitigated: RLS is active (the query runs inside `withTenantScope`), it is a read-only SELECT, and it is in the auth hot path where an HTTP round-trip per request would be prohibitive. The `@brain/mcp` package.json lists `"@brain/execution": "workspace:*"` as a dependency — so the workspace dependency exists, but the query bypasses the API layer. The CLAUDE.md lists "system/admin cross-tenant jobs" as sanctioned exceptions; MCP authentication is a reasonable candidate for that exception but is not explicitly listed.

**Verdict:** Violation present, RLS-mitigated, operationally acceptable but architecturally non-compliant. New finding: **R-28** (Low, acceptable for now).

### Dispatcher — correct JSON-RPC 2.0 implementation

`dispatcher.ts` handles: parse errors, method-not-found, all method branches, BrainError → JSON-RPC error code mapping (8 specific codes mapped to -32001 through -32005, unknown errors → -32603). The error mapping covers all new granular gate codes (e.g. `gate_balance_insufficient → -32004`).

### Services injected at boot — all present

`main.ts:1033–1041`:
```ts
const mcpServer = new BrainMcpServer({
  auth: mcpAuthVerifier,
  ledger: ledgerService,
  wiki: wikiService,
  raw: rawEvidenceService,
  paymentIntents: paymentIntentService,
  agentService,         // ← wired
  audit,
});
```

`agentService` is wired — `agent.action.propose` will not throw 500 in production. The `agentService` is marked optional in `McpServerDeps` (the tool throws internally if absent), and it IS supplied.

### `brain://ledger/obligations/{id}` resource — BROKEN

`resources.ts:96–100`:
```ts
case "ledger.obligation": {
  const list = await ctx.ledger.listObligations(ctx.ctx, { limit: 1 });
  const match = list.items.find((o) => o.id === parsed.id);
  if (match === undefined) throw brainError("ledger_row_not_found", "obligation not found");
```

This fetches the first 1 obligation from the database and tries to find the specific requested ID within that 1-item list. Unless the tenant's first obligation happens to be the one requested, every `brain://ledger/obligations/{id}` resource read returns `ledger_row_not_found`.

Root cause: `ILedgerService` has no `getObligation(ctx, id)` method — only `listObligations(ctx, filters)` with no `id` filter. The correct fix is either: (a) add `id` as a filter to `ObligationListFilters` in `ILedgerService`, or (b) pass a large `limit` and do the find in memory (inefficient but correct). **New finding: R-29 (Medium).**

### 5 resources — correct except obligation

| Resource URI | Handler | Correct? |
|---|---|---|
| `brain://ledger/accounts/{account_id}` | `ctx.ledger.getAccount()` | Yes |
| `brain://ledger/transactions/{transaction_id}` | `ctx.ledger.getTransaction()` | Yes |
| `brain://ledger/obligations/{obligation_id}` | `listObligations({ limit: 1 }).find(id)` | **BROKEN** |
| `brain://ledger/payment-intents/{id}` | `ctx.paymentIntents.get()` | Yes |
| `brain://wiki/pages/{slug}` | `ctx.wiki.getPage()` | Yes |

### 5 prompts — correct

All 5 prompts render to `wiki.question` calls via `render()`:
- `wiki.question.cash_flow_summary` (required: `period`)
- `wiki.question.bills_due` (optional: `days`, defaults to 7)
- `wiki.question.spending_change` (required: `period`)
- `wiki.question.invoice_status` (required: `invoice_number`)
- `wiki.question.subscriptions` (no args)

### Scope enforcement — correct

`enforceScopes()` at `server.ts:222–229` rejects a `tools/call` if the agent's JWT scopes do not include the tool's `requiredScopes`. `tools/list` returns all tools regardless of scope (by design — the client can see the surface but call is gated). `resources/read` scope is checked after resolution via `requireAll()`.

---

## 4. Runtime Validation

**Typecheck:**
```
pnpm --filter @brain/mcp run typecheck → 0 errors
```

**Tests:**
```
pnpm --filter @brain/mcp run test
→ 5 test files, 56 tests passed
  - dispatcher.test.ts (15)
  - resources.test.ts (9)
  - auth.test.ts (5)
  - tools/registry.no-execute.test.ts (3)
  - server.test.ts (24)
```

**Tool count assertion (server.test.ts:155):**
```ts
expect(r.tools.length).toBe(10);
```
Passes. Snapshot test (`registry.no-execute.test.ts`) freezes the surface — any new tool requires explicit snapshot update (P1.2 enforcement).

**Obligation resource — no integration test:**
`resources.test.ts` tests `parseBrainUri` and `listResources` only — it does not call `readResource`. The obligation bug has no test catching it.

**Cross-service DB query confirmed:**
```
services/mcp/src/auth.ts:117
SELECT id, tenant_id, state, scope_hash, onchain_address, role
  FROM agents WHERE id = $1 LIMIT 1
```
Uses `withTenantScope(this.pool, ...)` — RLS active, tenant-scoped read.

---

## 5. Functional Status

**Mostly Working** — 9 of 10 tools are correct and fully exercised. All 5 prompts are correct. 4 of 5 resources are correct. The auth chain is complete and correctly enforces all 4 checks. The one functional bug is the `brain://ledger/obligations/{id}` resource which structurally cannot return the right obligation.

---

## 6. Architectural Violations

**R-3 / R-28 — Cross-service direct DB read in auth path**

`@brain/mcp` depends on `@brain/execution` at the package.json level but queries the `agents` table directly via the shared pool rather than through `@brain/execution`'s `IAgentService` API. This violates the "cross-service reads through the owning service's API" rule.

Mitigations present: `withTenantScope` (RLS active), read-only SELECT, hot-path necessity. The dependency is one-way (no cycle: `@brain/execution` does not import `@brain/mcp`). The violation is real but the risk is low.

**No other layer violations found.** The MCP tools exclusively call injected service interfaces (`ILedgerService`, `IWikiMemoryService`, `IRawEvidenceService`, `IPaymentIntentService`, `IAgentService`) — no direct DB queries in any tool. No Wiki reads in the policy path. No execution from any tool.

---

## 7. Missing Pieces

1. **`brain://ledger/obligations/{id}` resource broken** — returns 404 for all but the tenant's first obligation. Requires either `getObligation(ctx, id)` on `ILedgerService` or removing the `limit: 1` cap. No test catches this (R-29).

2. **`readResource` not tested** — `resources.test.ts` covers `parseBrainUri` and `listResources` only. The end-to-end resource resolution path (`readResource`, which calls service methods) has zero test coverage. The obligation bug is invisible to CI.

3. **On-chain `BrainMCPAgentRegistry` unreachable without `MCP_AGENT_REGISTRY_ADDRESS`** — if `cfg.MCP_AGENT_REGISTRY_ADDRESS` is unset or falsy, `createViemScopeChecker` receives `undefined as \`0x${string}\`` — likely a runtime type error on the first MCP request. The `FakeAuthVerifier` path avoids this in dev; production requires the env var. No boot-time guard asserts it is present when `BRAIN_MCP_DEV_AUTH_BYPASS` is false.

4. **`agent_scope_hash_missing` error for agents with no on-chain attestation** — any agent registered off-chain without `scope_hash` throws at step 4 of auth. This is intentional per the design but means that until `BrainMCPAgentRegistry` deployment is complete, all MCP agents are effectively blocked.

---

## 8. Evidence

**10 tools confirmed via snapshot:**
```
services/mcp/src/tools/__snapshots__/registry.no-execute.test.ts.snap
exports[`MCP tool registry — no execution surface (P1.2) > snapshots ...`]
["agent.action.propose","ledger.account.get","ledger.accounts.list",
 "ledger.counterparties.list","ledger.obligations.list","ledger.transactions.list",
 "payment_intent.propose","raw.contribute","wiki.page.get","wiki.question"]
```

**Obligation bug — `limit: 1` then `find(id)`:**
```
services/mcp/src/resources.ts:96-100
case "ledger.obligation": {
  const list = await ctx.ledger.listObligations(ctx.ctx, { limit: 1 });
  const match = list.items.find((o) => o.id === parsed.id);
  if (match === undefined) throw brainError("ledger_row_not_found", "obligation not found");
```
`ILedgerService` has no `getObligation(ctx, id)` method (confirmed `shared/src/contracts/ILedgerService.ts`).

**`agentService` wired — `agent.action.propose` functional:**
```
services/api/src/main.ts:1039
agentService,   // injected — tool will not 500
```

**Auth chain cross-service read:**
```
services/mcp/src/auth.ts:116-122
return withTenantScope(this.pool, principal.tenantId, async (c) => {
  const { rows } = await c.query<AgentRecord>(
    `SELECT id, tenant_id, state, scope_hash, onchain_address, role
       FROM agents WHERE id = $1 LIMIT 1`, [principal.id],
  );
  return rows[0] ?? null;
});
```
`@brain/mcp/package.json`: `"@brain/execution": "workspace:*"` — workspace dep exists, API bypass confirmed.

**`payment_intent.execute` absent:**
The snapshot has 10 entries; none is `payment_intent.execute`. The `registry.no-execute.test.ts` exists precisely to enforce this.

---

## 9. Confidence Level

**High** — all 10 tool implementations, all 5 resources, and all 5 prompts are read in full. Boot wiring is verified at `main.ts:1033–1041`. Auth chain is traced end-to-end. The obligation bug is confirmed by reading both `resources.ts` and `ILedgerService.ts`. The 56 tests are run directly.

---

## 10. Production Readiness

**Score: 7/10 — Mostly Working**

| Dimension | Status |
|---|---|
| Tool surface (10 tools) | Correct and tested |
| Auth chain (4 checks) | Correct; on-chain registry enforced |
| Scope enforcement | Correct per-tool |
| Resources — 4 of 5 | Correct |
| Resource `brain://ledger/obligations/{id}` | Broken — always 404 |
| Prompts (5) | Correct |
| `agent.action.propose` wiring | Wired — functional |
| Audit emission | Emitted on every tool/resource call |
| Cross-service DB read | Violation present, RLS-mitigated |
| `readResource` test coverage | Zero — obligation bug invisible to CI |
| `MCP_AGENT_REGISTRY_ADDRESS` guard | No boot-time assertion; silent failure path |

**Production blockers:**
- `MCP_AGENT_REGISTRY_ADDRESS` must be set — no boot guard enforces this; missing it causes a runtime type error on first MCP request.
- All MCP agents need an on-chain `scope_hash` in `BrainMCPAgentRegistry` — without deployment, every agent is blocked at auth step 4.

**Non-blocking issues:**
- Obligation resource bug (R-29) — affects any MCP client using `brain://ledger/obligations/{id}` URIs. Medium severity: the tool `ledger.obligations.list` works correctly; only the resource URI is broken.

---

## 11. Refactor Priority

**Medium** — the MCP surface is substantially correct. Two fixes are needed:

1. **(R-29, Medium):** Fix `brain://ledger/obligations/{id}` resource — add `id` filter to `ObligationListFilters` in `ILedgerService`, implement `findObligationById` in `LedgerService`, and update `resources.ts`. Add an integration test for `readResource`.

2. **(R-28, Low):** Consider adding a `getAgent(ctx, id): Promise<AgentRecord | null>` method to `IAgentService` and having `McpAuthVerifier` call it rather than querying the `agents` table directly. This is a refactor for architectural correctness, not a bug fix — the current behavior is correct.

3. **(Boot guard):** Add a startup assertion: if `BRAIN_MCP_DEV_AUTH_BYPASS` is false, `MCP_AGENT_REGISTRY_ADDRESS` must be a valid `0x`-prefixed address.
