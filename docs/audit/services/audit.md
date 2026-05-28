# Audit: Audit Service (`@brain/audit`)

**Audited:** 2026-05-26
**Files examined:**
- `services/audit/src/merkle.ts`
- `services/audit/src/publisher.ts`
- `services/audit/src/reconciler.ts`
- `services/audit/src/repository.ts`
- `services/audit/src/webhooks.ts`
- `services/audit/src/verify.ts`
- `services/audit/src/server.ts`
- `services/audit/src/routes.ts` (existence confirmed)
- `services/audit/src/webhook-routes.ts` (existence confirmed)
- `services/audit/migrations/0001_audit_events.sql`
- `services/audit/migrations/0003_audit_v0_3.sql`
- `services/audit/migrations/0007_force_rls.sql`
- `shared/src/audit/emitter.ts`
- `shared/src/audit/hash.ts`
- `shared/src/webhooks/outbound.ts`
- `services/api/src/anchorBroadcaster.ts`
- `services/api/src/main.ts` (lines 974–1003, 1560–1609, 1637–1640)
- `shared/src/config.ts` (lines 96–145)

**Commands run:**
```
pnpm --filter @brain/audit run typecheck
pnpm --filter @brain/audit run test
grep -n "REVOKE UPDATE, DELETE|FORCE ROW|layer CHECK" services/audit/migrations/0001_audit_events.sql
grep -n "baseSepolia" services/api/src/anchorBroadcaster.ts
grep -n "event_hash|buildTree|leaves" services/audit/src/publisher.ts
grep -n "sha256|hashEvent" shared/src/audit/emitter.ts
```

---

## 1. Scope

This report covers:
- `@brain/audit` — Merkle tree construction, inclusion proofs, anchor publisher, anchor reconciler, audit event repository, webhook endpoint CRUD, dead-letter replay routes
- The `PostgresAuditEmitter` in `@brain/shared` — hash chain computation, per-tenant serialization, append-only enforcement
- `WebhookAuditEmitter` and `WebhookDispatcher` in `@brain/shared` — outbound delivery, dead-letter persistence, SSRF guard
- The `anchorBroadcaster.ts` in `services/api/src/` — viem on-chain write to `BrainAuditAnchor`
- Boot wiring and env-var gates in `main.ts`

Out of scope: the Solidity `BrainAuditAnchor.sol` contract (covered in `contracts/foundry.md`); the audit API routes surface (deferred to the API audit); MCP and HTTP transports.

---

## 2. Intended Architecture

Per `CLAUDE.md` Layer 6:

> Audit — append-only, Merkle-chained log + on-chain anchor publisher.

Per `Brain_MVP_Architecture.md §3`:
- Every service emits audit events via `PostgresAuditEmitter`; each event is SHA-256 hashed and chained to the previous tenant event (`prev_event_hash`).
- Hourly (configurable), the anchor broadcaster collects events in a time window, builds a Merkle tree (keccak256-based, matching the Solidity contract), and calls `BrainAuditAnchor.anchor()` on Base.
- An orphan reconciler runs every 5 minutes to backfill `onchain_tx_hash` for anchors where the process crashed between broadcast and DB update.
- Customer-facing webhooks receive 9 forwarded event types; failures land in a dead-letter queue with a replay route.

---

## 3. Actual Implementation

### Hash chain — correct

`shared/src/audit/emitter.ts:80–134` (`PostgresAuditEmitter.emit()`):
- Opens a DB transaction, sets `app.tenant_id`, then locks the latest tenant event with `FOR UPDATE` to serialize concurrent emits.
- Computes `event_hash = sha256(canonical(event + id + createdAt + prevEventHash))` via `hashEvent()`.
- Inserts the event with both `event_hash` and `prev_event_hash` as `BYTEA`.
- `REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC` enforces append-only at the DB layer (migration 0001:57).
- FORCE RLS applied by migration 0007 to all 4 audit tables.

The `FOR UPDATE` row lock ensures that concurrent emits for the same tenant cannot interleave — each emit reads the previous hash atomically within its transaction. This is correct but has a throughput implication: per-tenant audit emits are serialized.

### Layer constraint — `agent` layer added

Migration 0001 constrained `layer IN ('raw','wiki','policy','execution','audit')`. Migration 0003 extended it to `('raw','ledger','wiki','policy','execution','agent','audit')`. The agent-router now emits `layer: "agent"` events (confirmed in audit #8). The constraint covers it.

### Merkle tree — keccak256, correct, cross-verified with contract

`merkle.ts` implements:
- `hashLeafKeccak(leaf)` = keccak256(0x00 || leaf)
- `hashInternalKeccak(a, b)` = keccak256(0x01 || min(a,b) || max(a,b)) — lexicographic sort prevents left/right ordering ambiguity
- Odd-node duplication: when a layer has an odd number of nodes, the last node is paired with itself

The scheme matches `BrainAuditAnchor.sol::verifyInclusion` per the module comment. viem's `keccak256` is used (not Node's `node:crypto` SHA3-256 which is a different function). `verifyProof` is property-tested via `fast-check` (`merkle.inclusion.property.test.ts`).

### Two-layer hash scheme

`publisher.ts:67–68`:
```ts
const leaves = events.map((e) => e.event_hash);
const tree = buildTree(leaves);
```

Each audit event's `event_hash` (32-byte SHA-256 of the canonical event JSON) is used as the raw leaf data passed to `buildTree`. The Merkle tree then applies `hashLeafKeccak(leaf)` = keccak256(0x00 || sha256_hash) to produce the leaf node. The final Merkle root is committed on-chain.

Off-chain verification: `verifyInclusion(root, sha256_event_hash, proof)` applies the same `hashLeafKeccak` internally. This is consistent — callers must supply the raw sha256 `event_hash` (not the pre-keccak leaf node) when building proofs.

### `publishAnchor` — correct and idempotent

`publisher.ts:58–103`:
1. Collects events in `[periodStart, periodEnd)` via `listEventsForAnchor`
2. Empty window → returns `null` (no-op)
3. Checks `findAnchorByRoot` before insert — no-op if root already exists (§5.3 idempotency)
4. Inserts anchor row with `ON CONFLICT (tenant_id, merkle_root) DO NOTHING RETURNING *`; if suppressed, fetches the winning row
5. Broadcasts (`broadcaster(...)`) **outside** the DB transaction — deliberate, documented
6. Writes back `onchain_tx_hash` + `block_number` in a second scoped transaction

The crash window between step 5 (broadcast) and step 6 (write-back) is correctly identified and handled by the orphan reconciler.

### Anchor broadcaster — hardcoded to `baseSepolia` (R-30, High)

`services/api/src/anchorBroadcaster.ts:47,52,125`:
```ts
chain: baseSepolia,
```
All three client constructions (wallet, public, public for reader) hardcode `baseSepolia`. The `RPC_URL` default in `shared/src/config.ts:96` is also `https://sepolia.base.org`.

**This means the production broadcaster will anchor on Base Sepolia, not Base Mainnet.** There is no configurable chain parameter — the chain is baked into the viem client at construction time, regardless of what `BASE_RPC_URL` is set to. A production deployment with a mainnet RPC URL will still route the transaction to Sepolia (viem uses the chain's hardcoded endpoint if the transport URL matches a known chain, but the `chain: baseSepolia` forces the transaction parameters — chain ID 84532 instead of mainnet 8453). Any mainnet contract address will be unreachable on Sepolia.

### Orphan reconciler — correct

`reconciler.ts:49–105`:
- Queries `audit_anchors WHERE onchain_tx_hash IS NULL` with `pool.query` (cross-tenant, requires `brain_privileged` or owner role — same pattern as normalize worker)
- For each orphan, calls `reader.findAnchorTx({ tenantId, merkleRoot })` (on-chain log scan)
- If found: `setAnchorTxHash` (tenant-scoped)
- If not found and age > `orphanGraceMs` (default 1h): emits `audit.anchor.orphan_detected` + `console.warn`
- Runs every 5 minutes via `setInterval`. Stopped gracefully in `shutdown()` (`main.ts:1640`: `anchorReconciler?.stop()`)

**Reconciler activation gate:** `cfg.AUDIT_ANCHOR_ADDRESS !== undefined && anchorRpcUrl !== undefined` — started whenever the contract address and an RPC URL are configured, even without `AUDIT_PUBLISHER_KEY`. This is correct: the reconciler is read-only (log scan only) and doesn't need the publisher key.

### WebhookAuditEmitter — fire-and-forget with dead-letter (R-9 partially addressed)

`shared/src/webhooks/outbound.ts:174–189`:
```ts
setImmediate(() => {
  this.dispatcher.dispatch(result).catch((err) => {
    console.warn("[webhooks] dispatch threw unexpectedly", err);
  });
});
```

Delivery is fire-and-forget after `setImmediate` — the audit event is written before delivery is attempted. Failures do NOT propagate to the emitter caller (by design).

**H-20 dead-letter queue (partially resolves R-9):** `WebhookDispatcher.dispatch()` now persists delivery failures to `webhook_dead_letters` (via `recordDeliveryFailure`). Success clears prior dead-letters for that `(endpoint_id, event_id)` pair. The dead-letter replay route (`POST /v1/webhooks/{endpoint_id}/replay`) re-delivers and removes successfully-replayed entries.

**Still missing:** there is no automatic retry schedule. A BullMQ retry worker is acknowledged as the planned follow-up in `CLAUDE.md`. The dead-letter queue requires operator-triggered replay. R-9 is partially mitigated but not resolved.

### SSRF guard

`isPublicUrl()` is called before every delivery. Private/internal/metadata addresses are blocked. This is correct.

### 9 forwarded event types

`FORWARDED_EVENTS` set (outbound.ts:33–43): `payment_intent.created`, `payment_intent.approved`, `payment_intent.rejected`, `payment_intent.execute.after`, `ledger.counterparty.created`, `ledger.transaction.created`, `ledger.obligation.created`, `policy.evaluate`, `raw.ingest.completed`. All 9 are legitimate audit event actions emitted by existing services.

---

## 4. Runtime Validation

**Typecheck:**
```
pnpm --filter @brain/audit run typecheck → 0 errors
```

**Tests:**
```
pnpm --filter @brain/audit run test
→ 7 test files, 42 tests passed
  - repository.test.ts (19)
  - merkle.inclusion.property.test.ts (1) — fast-check property test: every leaf verifies
  - merkle.test.ts (10) — leaf/internal/proof/verify correctness
  - reconciler.test.ts (4) — recovered, flagged, no-op, grace window
  - webhook-routes.test.ts (4) — list dead-letters, replay
  - index.test.ts (1)
  - routes.test.ts (3) — query, entity lookup, anchor publish
```

**Append-only enforcement confirmed:**
```
services/audit/migrations/0001_audit_events.sql:57
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
```

**FORCE RLS confirmed:**
```
services/audit/migrations/0007_force_rls.sql
ALTER TABLE audit_anchors       FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events        FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_dead_letters FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints   FORCE ROW LEVEL SECURITY;
```

**Anchor broadcaster chain hardcoded to Sepolia:**
```
services/api/src/anchorBroadcaster.ts:47,52,125
chain: baseSepolia   (three occurrences)
```
No `chain` parameter accepted. `RPC_URL` default: `https://sepolia.base.org` (config.ts:96).

**Hash scheme:**
- `event_hash`: SHA-256 (Node crypto, `createHash("sha256")`) via `hashEvent()`
- Merkle leaf nodes: keccak256(0x00 || sha256_event_hash) via `hashLeafKeccak()`
- Merkle internal nodes: keccak256(0x01 || min(a,b) || max(a,b)) via `hashInternalKeccak()`

---

## 5. Functional Status

**Mostly Working** — all core logic is correct (hash chain, Merkle tree, publisher idempotency, reconciler, dead-letter queue). The anchor broadcaster has a hard production blocker: chain is hardcoded to Base Sepolia.

---

## 6. Architectural Violations

**No layer boundary violations found.** `@brain/audit` accesses only its own tables. The `PostgresAuditEmitter` in `@brain/shared` writes to `audit_events` directly — this is the explicitly documented cross-layer exception (all services write audit events; the emitter rewiring to the Audit API is deferred per the module comment).

**Reconciler cross-tenant read:** `reconciler.ts:57` calls `pool.query(...)` without `withTenantScope` — intentional, documented (same pattern as normalize worker), requires the `brain_privileged` (BYPASSRLS) role. Not a violation; it is the correct pattern for system jobs.

**`audit_events` schema owned but not exclusively written by `@brain/audit`:** Every service writes directly to `audit_events` using `PostgresAuditEmitter`. The migration comment acknowledges this will be rewired to the Audit API in a later stage. This is an intentional deferral, not a violation. No service other than `@brain/audit` reads from `audit_events`.

---

## 7. Missing Pieces

1. **Anchor broadcaster hardcoded to `baseSepolia`** — production mainnet anchoring will not work (R-30).

2. **Automatic webhook retry** — dead-letter queue exists and replay route is implemented, but re-delivery requires operator action. No BullMQ retry worker exists (R-9, partially mitigated).

3. **`AUDIT_PUBLISHER_KEY` and `AUDIT_ANCHOR_ADDRESS` have no boot-time validation** — if `AUDIT_PUBLISHER_KEY` is set but `AUDIT_ANCHOR_ADDRESS` is absent (or vice versa), the broadcaster is conditionally undefined and anchoring silently does not start. No warning is logged. A runtime assertion that either both are set or neither are would prevent silent misconfigurations.

4. **Anchor broadcaster activation gate note:** `anchorBroadcaster` activates only when `AUDIT_PUBLISHER_KEY !== undefined` (`main.ts:975`). The reconciler activates when `AUDIT_ANCHOR_ADDRESS !== undefined && anchorRpcUrl !== undefined`. These two gates are independent — a process with `AUDIT_ANCHOR_ADDRESS` but no `AUDIT_PUBLISHER_KEY` will run the reconciler but not publish. This is intentional (reconciler is read-only) but undocumented.

---

## 8. Evidence

**Merkle property test passes (every leaf verifies):**
```
src/merkle.inclusion.property.test.ts (1 test) — fast-check, 100 runs
```

**Two-layer hash confirmed (publisher.ts:67–68):**
```ts
const leaves = events.map((e) => e.event_hash);  // sha256 buffers
const tree = buildTree(leaves);                   // keccak256 Merkle over sha256 leaves
```

**Anchor broadcaster — Sepolia hardcode:**
```ts
// anchorBroadcaster.ts:47
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,   // ← production blocker
  transport,
});
```

**RPC_URL config default:**
```ts
// shared/src/config.ts:96
RPC_URL: z.string().url().default("https://sepolia.base.org"),
```

**Dead-letter persistence in WebhookDispatcher:**
```ts
// shared/src/webhooks/outbound.ts:142–149
await recordDeliveryFailure(scoped, {
  tenantId: event.tenantId,
  endpointId: ep.id,
  eventId: event.id,
  eventType: event.action,
  payload: payloadObj,
  error: result.error ?? "delivery failed",
});
```

**Reconciler graceful stop wired:**
```ts
// services/api/src/main.ts:1640
anchorReconciler?.stop();
```

---

## 9. Confidence Level

**High** — all critical files read in full. The Merkle implementation, publisher flow, emitter hash chain, and reconciler are all directly traced. The anchor broadcaster chain hardcode is observed directly in source and config. Tests are run and pass. The only area not directly exercised is live on-chain interaction (requires `AUDIT_PUBLISHER_KEY` + a live Base RPC).

---

## 10. Production Readiness

**Score: 6/10 — Mostly Working (logic), Blocked (on-chain)**

| Dimension | Status |
|---|---|
| Hash chain correctness | Correct — FOR UPDATE serialization, SHA-256, prev_event_hash |
| Append-only DB enforcement | Correct — REVOKE UPDATE/DELETE + FORCE RLS |
| Merkle tree | Correct — keccak256, property-tested, matches contract scheme |
| Publisher idempotency | Correct — ON CONFLICT DO NOTHING + pre-insert check |
| Orphan reconciler | Correct — crash recovery, grace window, audit emit |
| On-chain anchor broadcast | **Blocked** — hardcoded `baseSepolia`; mainnet anchoring will fail |
| Webhook delivery | Fire-and-forget with dead-letter persistence; no auto-retry |
| Dead-letter replay | Implemented — operator-triggered |
| SSRF guard | Implemented |
| FORCE RLS | All 4 tables covered |

**Production blocker:**
- **R-30** — `anchorBroadcaster.ts` hardcodes `chain: baseSepolia`. Any production deployment targeting Base Mainnet will submit anchor transactions to Sepolia (chain ID 84532), not mainnet (chain ID 8453). On-chain audit verification is not possible until this is corrected.

**Fix:** Accept `chainId` or a viem `Chain` object as a parameter to `createViemAnchorBroadcaster` and `createViemAnchorEventReader`. Add a `AUDIT_ANCHOR_CHAIN` env var (`"base" | "base-sepolia"`, defaulting to `"base-sepolia"` for safety) and resolve the correct viem chain at boot.

---

## 11. Refactor Priority

**Medium** overall; **High** for R-30 specifically before mainnet deployment.

1. **(R-30, High before mainnet):** Make `chain` configurable in `anchorBroadcaster.ts`. One-line change in the factory function + one env var.

2. **(R-9, Medium):** Automatic webhook retry via BullMQ. The dead-letter table exists; a worker draining it on a schedule (with exponential backoff) is the missing piece.

3. **(Low):** Add boot-time assertion: either both `AUDIT_PUBLISHER_KEY` and `AUDIT_ANCHOR_ADDRESS` are set, or neither. Silent partial configuration is a footgun.
