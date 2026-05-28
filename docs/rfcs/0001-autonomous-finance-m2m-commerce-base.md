# RFC 0001. Autonomous Finance + Machine-to-Machine Agent Commerce on Base

- **Status:** Accepted. Implemented shadow-first (Phases 1–3 landed; see
  Implementation status below).
- **Date:** 2026-05-26 (accepted 2026-05-27)
- **Authors:** ai-assisted
- **Affects:** Ledger, Policy, Agent (execution), Audit layers; `contracts/`; the
  `agent-router` promotion model; the `@brain/mcp` surface; the published docs.

> This RFC is a build plan, not a spec change yet. Nothing here weakens the §6
> gate, the layer boundaries, the RLS posture, or the audit append-only
> invariant. Each on-chain primitive ships **shadowed**, is promoted **one at a
> time** behind `scripts/check-promotion-readiness.mjs` (H-24), and no money
> contract reaches mainnet without an external audit (`contracts/AUDIT-SCOPE.md`).

## Implementation status (2026-05-27)

The off-chain spine for x402 + escrow is built and **live-in-shadow**. Every
piece fails closed until explicitly promoted; no money can move.

- **Phase 1 (Ledger):** on-chain-settlement reconciliation matcher, agent
  counterparties (`type=agent` + `agent_id` + `onchain_address`), USDC
  `chain_tx_hash`. Shipped.
- **Phase 2 (x402):** `X402BaseRail` (USDC-on-Base, fails closed), the
  `x402_settle` action type + settlement-context carriage, and new §6 gate
  checks 3.5 (on-chain-settlement-permitted), 5.5 (agent-counterparty
  attestation), 6.5 (x402 payment-context), 8.5 (micropayment cap). Shipped.
- **Phase 3 (escrow):** `BrainEscrow` reference contract (**UNAUDITED /
  testnet-only**, hash-only) + Foundry unit/fuzz/invariant tests, §6 gate check
  6.6 (escrow-state binding), and the `escrow_release` action + carriage.
  Shipped. **Extended** with incremental partial release/refund (milestone
  payments + arbiter dispute-splits); 6.6 now binds against the escrow's
  _remaining_ balance.
- **Deferred live-wiring (TODO):** the concrete on-chain readers/loaders that
  make checks 3.5 / 5.5 / 6.6 / 8.5 _enforce_ (registry attestation,
  rolling-window spend, escrow state via `getEscrow`, the policy-VM dimensions);
  registering the `x402_base` / `escrow_base` rails at boot; and promoting a
  commerce agent into `LIVE_AGENTS`. Each gate check is **dormant** (records no
  row) until wired. The canonical §6 path is unchanged meanwhile.
- **Gated on external audit:** any mainnet deployment of `BrainEscrow` (§9).
- **Phase 4 (open ecosystem):** off-chain spine shipped. The Coinbase Spend
  Permission ↔ session-key model + resolver (ERC-4337 / Coinbase Smart Wallet /
  CDP Paymaster interop, §7.5) and reputation as a tighten-only Policy threshold
  input (`services/policy/src/reputation.ts`). The live external SDK construction
  remains deferred wiring.
- **Phase 5 (ERC-8004 reputation, §7.7 / D-6):** `BrainReputationRegistry`
  reference contract (**UNAUDITED / testnet-only**, **non-custodial**, hash-only)
 . Per-agent reputation pointer / Merkle root with a monotonic epoch,
  attestor-written, read by Policy as a threshold input only (never a money gate,
  never a §6 precondition) + Foundry unit/fuzz/invariant tests. Shipped. The live
  on-chain `ReputationResolver` reader is deferred wiring.
- **Gated on external audit:** any mainnet deployment of `BrainEscrow` and
  `BrainReputationRegistry` (§9). The registry is non-custodial but batched into
  the same audit for completeness.

## 1. Goal

Support the full autonomous-finance narrative (all six protocol layers) **and**
add machine-to-machine (M2M) agent commerce **now**, positioned as a first-class
participant in **Base's** ecosystem (x402 payments, Coinbase Smart Wallet / 4337
account abstraction, USDC settlement, on-chain proof).

## 2. Design principle (non-negotiable)

**Extend the spine; never fork the payment path.** Every money movement. ACH,
on-chain transfer, and the new x402/agent-commerce settlement. Flows through
the same chain:

```
PaymentIntent  →  §6 deterministic gate  →  rail dispatch  →  audit (Merkle-anchored on Base)
```

The differentiator is not "another payment rail." It is **governed, provable
x402**: an autonomous machine payment that carries a deterministic policy
decision and an on-chain audit proof. Ungoverned x402 is a commodity; the gate +
audit are the moat. And M2M (autonomous, high-frequency, agent-initiated) is
exactly where that governance is most valuable.

**Anti-goal:** a separate "fast" un-gated path for agent micropayments. If
throughput is the concern, the answer is aggregation/streaming into the gate
(§7.4), not around it.

## 3. Data classification & on-chain privacy (non-negotiable)

Brain is non-custodial and customer data is sensitive. The expansion onto Base
**does not** change the privacy posture: **commitments on-chain, data off-chain.**
This is already how the contracts work today and it is now an enforced invariant
for everything M2M adds.

### 3.1 The invariant

**PII and financial detail never go on-chain. Only hashes, Merkle roots, opaque
identifiers, and the values intrinsic to a settlement transfer (amount + counterparty
address) do.** The chain holds _commitments_; the data they commit to lives
off-chain in Postgres under RLS (and per-tenant blob prefixes).

### 3.2 Data classification

| Data                                                                 | Where it lives             | On-chain?                                                       |
| -------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| Balances, transactions, invoices, **counterparty names**, line items | Postgres, RLS per-tenant   | ❌ never                                                        |
| Wiki memory / narrative, reasoning traces, evidence                  | Postgres, RLS              | ❌ never                                                        |
| **Audit event payloads** (the who/what/why)                          | Postgres, RLS              | ❌. Only the **Merkle root** is anchored (`BrainAuditAnchor`)  |
| Policy specifics, spend envelopes                                    | Postgres + signed template | ❌. Only a **policy-version hash** (`BrainPolicyRegistry`)     |
| Agent identity / scope / behavior                                    | Registry                   | ❌. Only `bytes32 agentId/scopeHash/behaviorHash` + address    |
| **Escrow job terms**                                                 | Postgres                   | ❌. Only a **hash/commitment** on-chain                        |
| **Reputation history** (ERC-8004)                                    | Postgres                   | ❌. Only a **pointer / Merkle root** on-chain                  |
| x402/USDC **settlement: amount + payee address**                     |.                          | ✅ **intrinsic to any on-chain payment** (pseudonymous, no PII) |

### 3.3 Why this matters most (compliance)

On-chain data is **immutable and un-erasable**, which collides directly with
GDPR/CCPA right-to-erasure. That is _the_ reason raw PII can never go on-chain:
you could not delete it. Hashes/roots are not personal data; the erasable records
live off-chain where deletion is possible. The hash-only model is therefore a
hard compliance constraint, not a stylistic choice.

### 3.4 The genuine new exposure (and mitigations)

Going more on-chain for M2M introduces real risk. Not from putting data
on-chain, but from the public nature of on-chain settlement:

1. **Transaction-graph linkability.** On-chain USDC flows are public +
   pseudonymous; chain analysis can link a tenant's account payments (amount,
   counterparty, timing). **Mitigations:** address hygiene (per-tenant and/or
   per-purpose accounts, rotating session-key holders, no address reuse); treat
   the `bytes32 tenantId` as a correlation key worth salting/rotating (D-8).
2. **Amount visibility.** On-chain amounts are public; ACH amounts are not. So
   **rail choice is a privacy decision.** "On-chain settlement allowed?" becomes
   a **policy dimension + a §6 gate check** (§6 check 5), so a tenant can route
   sensitive/large payments over ACH and reserve x402 for machine commerce where
   pseudonymity is acceptable.

### 3.5 Enforcement

A `scripts/check-no-onchain-pii.mjs` guard (precedent: `check-gate-bypass`,
`check-scope-vocab`) asserts that contract call sites pass only hashes /
`bytes32` / addresses / amounts. Never raw tenant/customer/invoice fields. Wired
into `pnpm run lint`.

## 4. What already exists (the foundation)

Brain is already Base-native at the execution layer; M2M commerce is additive,
not greenfield:

- **Action types** (`services/execution/src/payment-intents/routes.ts`):
  `ach_outbound`, `ach_inbound`, `wire`, `onchain_transfer`, `erp_writeback`,
  `card_payment`.
- **Rails** (`services/execution/src/rails/types.ts`,
  `RailKind = "bank_ach" | "erp_writeback" | "onchain_base" | "notification"`):
  `OnchainBaseRail` (`BrainSmartAccount.executeViaSessionKey`, nonce-threaded,
  KMS-signed) and `AchPlaidRail` already implement the `Rail.dispatch` contract.
- **Smart account** (`contracts/src/BrainSmartAccount.sol`): a session-key model
  with on-chain **spend caps**, **`policyVersion` binding at grant time**,
  pause/revoke, and nonce replay protection. (Conceptually ≈ Coinbase **Spend
  Permissions**. See §7.5.)
- **On-chain footprint is already commitment-only:** `BrainAuditAnchor` anchors
  `(bytes32 tenantId, bytes32 root)`; `BrainMCPAgentRegistry` stores only
  `bytes32` ids/hashes + an address. No PII on-chain today.
- **Promotion** (`services/agent-router/src/promotion-config.ts`,
  `promotion.ts`): shadow-by-default; `LIVE_AGENTS` is the single allowlist;
  wired at `services/api/src/main.ts` (`isShadowed`, `checkRail`).
- **Audit** (`services/audit`): append-only, Merkle-chained, anchored on Base.
- **Reconciliation** (`services/ledger/src/reconciliation/`): includes a
  wallet-transfer matcher for on-chain settlement.

## 5. Layer-by-layer build plan

| Layer            | Net-new work for M2M + Base                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Raw / Ledger** | USDC/stablecoin accounting (balances, transactions); **agent counterparties** (a payee that is itself a registered agent); **escrow** as a new obligation/settlement type; on-chain settlement reconciliation matcher for x402/escrow.      |
| **Wiki**         | No new role. Narrative memory of agent counterparties + job history (read projection only).                                                                                                                                                 |
| **Policy**       | **Micropayment spend envelopes** + per-agent rate limits in the signed policy template; **on-chain-settlement-allowed** flag per payment class; attestation/reputation as policy _inputs_ (informing thresholds, never replacing the gate). |
| **Agent**        | x402/commerce agents promoted through the **same** shadow→readiness→live model; **ERC-8004**-style reputation as an additive `BrainMCPAgentRegistry` extension (pointer/root only).                                                         |
| **Execution**    | **New `x402` rail + action type** (§7.3); **Coinbase Smart Wallet / 4337 + CDP Paymaster** interop for gasless agent UX (§7.5); **escrow settlement** contract + rail (job terms hashed).                                                   |
| **Audit**        | The headline M2M feature. Every machine payment provable on Base **via Merkle inclusion against an anchored root** (data stays off-chain). Expose via the proof viewer + a settlement-proof resource.                                      |

## 6. New §6 gate checks (determinism preserved)

The gate gains checks; it does **not** gain discretion. Proposed additions
(numbered in the existing `1.5 / 7.5 / 9.5 / 11.5` "hardening addition" style so
they slot into the snapshot):

1. **x402 payment-context validation**. The x402 `paymentRequirements`
   (amount, asset=USDC, network=Base, recipient) match the PaymentIntent.
2. **Escrow-state binding**. For escrow settlements, the on-chain escrow lock
   matches the intent before release: still `Locked`, enough **remaining**
   (`amount − released − refunded`) to cover this release (the escrow settles
   incrementally. Milestones / dispute-splits. So binding against `remaining`,
   not the total `amount`, is what lets a second milestone through), same parties
   and job-id hash.
3. **Agent-counterparty attestation**. When the payee is an agent, it is
   registered + attested in `BrainMCPAgentRegistry` and not paused.
4. **Micropayment cumulative cap**. Per-agent rolling-window spend stays within
   the policy envelope (mirrors the on-chain session-key window cap, so the
   off-chain gate and on-chain contract agree).
5. **On-chain settlement permitted**. The payment class is allowed to settle
   on-chain for this tenant (the privacy/rail-sensitivity dimension, §3.4). If
   not, the gate fails closed and the payment must route over an off-chain rail.

Reputation may _raise or lower a policy threshold_ but must never _be_ the
precondition. LLM/reputation judgment stays out of the deterministic path
(Standards §6, Principle #5).

## 7. Component designs

### 7.1 PaymentIntent: new action type

Add `x402_settle` (and, if escrow is distinct, `escrow_release`) to
`ACTION_TYPES`. The invoice-shortcut-style resolver pattern (P0.5) resolves an
x402 payment request → `{ source_account_id, destination (agent counterparty),
amount, currency: "USDC" }`. Every field the gate needs is resolved up front and
re-validated by the gate at execute time. The x402 request metadata stays
off-chain; only the settlement transfer is on-chain.

### 7.2 Promotion / rail allowlist

- Add a promotion rail key `x402` (the short-key vocabulary used by
  `railKindForAction` in `main.ts`) and a `RailKind` value `x402_base` (the
  `Rail` interface vocabulary). Keep the two vocabularies explicitly mapped.
- A commerce agent ships as `LIVE_AGENTS = { …, commerce: [] }` (shadowed) and is
  promoted to `commerce: ["x402"]` only after `check-promotion-readiness`
  passes for it.

### 7.3 The `x402` rail

Implements the existing `Rail` contract:

```ts
// services/execution/src/rails/x402-base.ts
export class X402BaseRail implements Rail {
  readonly kind: RailKind = "x402_base";
  // Settles a USDC payment on Base per the x402 payment requirements,
  // via the smart account (session key) or a 4337 UserOp + paymaster.
  // Returns a typed receipt (tx hash, settled amount, block) → execution
  // row transitions dispatched → settled on confirmation, like OnchainBaseRail.
  dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    /* … */
  }
}
```

Like the other real rails, it fails closed when its client isn't configured and
must not fake-settle under `NODE_ENV=production` (mirror `rails/stubs.ts`).

### 7.4 Throughput without bypass

For high-frequency agent payments, settle in **aggregated batches** or via a
**payment channel / streaming** primitive that still produces one gated
PaymentIntent per settlement window (not per micro-transaction). The gate runs on
the settlement, not on every sub-cent event. This preserves determinism + audit
while keeping per-payment cost viable.

### 7.5 Account model: two coexisting flows, one gate

- **Internal governed path** (Brain acting on a tenant's funds): keep the custom
  session-key `BrainSmartAccount`. It already encodes spend caps + policy-version
  binding and is simpler/auditable. **No 4337 rewrite here.**
- **Open ecosystem path** (external agents/wallets in Base's ecosystem): add a
  **4337 / Coinbase Smart Wallet–compatible** surface + **CDP Paymaster** for
  gasless agent UX. Coinbase **Spend Permissions** map closely onto Brain's
  session-key+cap model, easing convergence.
- Both paths terminate in the **same** PaymentIntent + §6 gate + audit.

### 7.6 Escrow settlement

A new on-chain escrow contract (lock → attest job completion → release/refund),
represented in the Ledger as an obligation/settlement type. **Job terms are
hashed**; only the commitment + amounts + party addresses are on-chain. Lock and
release each emit audit events and pass the gate (escrow-state-binding check,
§6.2). **Audit required before mainnet** (§9).

### 7.7 Reputation (ERC-8004)

Extend `BrainMCPAgentRegistry` (or a companion registry) with a reputation
**pointer / Merkle root**. Never raw history. It feeds Policy as
**evidence/threshold input** only. It is explicitly **not** a contract-level money
gate and **not** a §6 precondition.

## 8. Sequencing (build now, safely)

Each step is shadow-launched and individually promotable:

1. **USDC ledger + on-chain settlement reconciliation**. The foundation;
   incremental on existing ledger/reconciliation/rail code.
2. **`x402` rail + `x402_settle` action type** through the gate (shadowed).
3. **Coinbase Smart Wallet / 4337 + CDP Paymaster** interop for gasless UX.
4. **Escrow contract + `escrow_release`** settlement type (post-audit).
5. **ERC-8004 reputation** as a Policy input.

Promotion of any money-moving agent stays gated by `check-promotion-readiness`
(H-24): outbox/RLS, gate checks, typed rail receipts, replay endpoint,
halt-category tests, adversarial coverage, on-chain behavior hash, session-key
grants.

## 9. Smart-contract safety

- New money contracts (x402 settlement, escrow) are added to
  `contracts/AUDIT-SCOPE.md` and **externally audited before mainnet**.
- **No raw data in calldata**. Contract interfaces accept only hashes /
  `bytes32` / addresses / amounts (§3.5 enforces this in CI).
- Default posture stays **immutable** (CLAUDE.md: no upgradable contracts in
  MVP). If a deliberate upgrade path is wanted for fast-moving commerce
  primitives, it must be an explicit decision (timelock + multisig), audited.
  not the default. (See Decision D-3.)

## 10. Decisions needed (decision log)

| #       | Decision                                                      | Recommendation                                                                                           |
| ------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **D-1** | Product framing: governance layer _and_ M2M commerce network? | **Both** (this RFC assumes it).                                                                          |
| **D-2** | Adopt 4337 / Coinbase Smart Wallet for the open surface?      | **Yes, for the external surface only**; keep session keys internally.                                    |
| **D-3** | Upgradeable escrow/x402 contracts?                            | **Immutable by default**; timelock+multisig only if explicitly justified + audited.                      |
| **D-4** | Settlement asset for M2M?                                     | **USDC on Base** (x402-native).                                                                          |
| **D-5** | Throughput model for micropayments?                           | **Aggregated/streamed settlement** through the gate (§7.4).                                              |
| **D-6** | Reputation standard?                                          | **ERC-8004-style**, as a Policy input only (pointer/root on-chain).                                      |
| **D-7** | On-chain settlement per payment class?                        | **Policy dimension + gate check** (§6 check 5); default off-chain for sensitive classes.                 |
| **D-8** | On-chain address hygiene to limit linkability?                | **Per-tenant/per-purpose accounts + rotating session keys**; salt/rotate the on-chain tenant identifier. |

## 11. Risks

- **Forking the payment path** (the cardinal risk). Mitigated by §2/§6: one
  gate, one audit trail.
- **Data on-chain / PII leakage**. Mitigated by §3: hash-only invariant + CI
  guard; on-chain settlement is a gated policy dimension.
- **Transaction-graph linkability + amount visibility**. Mitigated by §3.4
  (address hygiene, rail-by-sensitivity).
- **GDPR/erasure vs on-chain immutability**. Mitigated by §3.3 (no erasable
  personal data ever anchored).
- **Un-audited money contracts**. Mitigated by §9.
- **Gate throughput** under M2M frequency. Mitigated by §7.4 aggregation.
- **Counterparty trust** for agent payees. Mitigated by the attestation check
  (§6 check 3) against the registry.
- **Doc/reality drift** re-opening. Mitigated by §12 (promote to spec as each
  lands; don't let the narrative outrun the enforcement).

## 12. Documentation restructure (Shipped / In-Progress / Planned)

The published docs (docs.brain.fi, sourced from this repo's markdown) currently
describe parts of this vision as if shipped. With the vision now committed, the
fix is **status discipline**, not deletion: tag every relevant page and promote
it into the source-of-truth specs (OpenAPI / Standards / Architecture) as it
lands. Build to the spec, not the narrative.

| Doc area                                                       | Status today                             | Action                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Six-layer stack, gate, provenance, RLS, audit, propose≠execute | **Shipped**                              | Reconcile stale facts (gate count = 13+4=17; anchor cadence = hourly; remove "Policy reads Wiki").               |
| MCP surface (9 tools, no execute)                              | **Shipped**                              | Fix tool count (9), scopes (`execution:propose`), error codes, resource URIs.                                    |
| API reference (auth, errors, endpoints)                        | **Shipped (drifted)**                    | Regenerate from `Brain_API_Specification.yaml` + `shared/src/errors.ts` + `scopes.ts`; remove phantom endpoints. |
| Session-key `BrainSmartAccount`                                | **Shipped**                              | Replace the ERC-4337 `validateUserOp` description with the real session-key model.                               |
| On-chain privacy / data classification                         | **Shipped (implicit)**                   | Document §3 explicitly: commitments on-chain, data off-chain, GDPR rationale.                                    |
| x402 / agent commerce                                          | **Planned (this RFC)**                   | Mark **Planned**; build per §7–§8; promote to spec on landing.                                                   |
| Escrow / ERC-8183                                              | **Reference impl (UNAUDITED / testnet)** | `BrainEscrow` w/ partial release/refund; mainnet gated on §9 audit.                                              |
| ERC-8004 reputation                                            | **Reference impl (UNAUDITED / testnet)** | `BrainReputationRegistry` (non-custodial, hash-only pointer); Policy tighten-only input. Audit-batched.          |
| 4337 / Coinbase Smart Wallet / paymaster                       | **Off-chain spine shipped**              | Spend Permission ↔ session-key model + resolver (§7.5); live SDK construction deferred.                          |
| Proxy + timelock upgrades                                      | **Not planned (MVP)**                    | Mark **Not in MVP**; revisit per D-3.                                                                            |

**Enforcement:** add a doc-drift CI check (precedent: `check-scope-vocab`,
`check-gate-bypass`) asserting (a) every endpoint named in `api-reference/*.md`
exists in the OpenAPI spec, and (b) numeric claims (gate count, anchor cadence)
match code constants. This is how the narrative stays honest as it grows.

## 13. Non-goals (for this RFC)

- Custody of funds (Brain remains non-custodial. Reads, reasons, governs).
- **Putting PII or financial detail on-chain. Ever** (only hashes / roots /
  commitments / intrinsic settlement values; §3).
- Replacing the deterministic gate with reputation/LLM judgment.
- A parallel un-gated agent-payment path.
- Upgradeable contracts by default.
