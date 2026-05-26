# RFC 0001 — Autonomous Finance + Machine-to-Machine Agent Commerce on Base

- **Status:** Draft (for review)
- **Date:** 2026-05-26
- **Authors:** ai-assisted
- **Affects:** Ledger, Policy, Agent (execution), Audit layers; `contracts/`; the
  `agent-router` promotion model; the `@brain/mcp` surface; the published docs.

> This RFC is a build plan, not a spec change yet. Nothing here weakens the §6
> gate, the layer boundaries, the RLS posture, or the audit append-only
> invariant. Each on-chain primitive ships **shadowed**, is promoted **one at a
> time** behind `scripts/check-promotion-readiness.mjs` (H-24), and no money
> contract reaches mainnet without an external audit (`contracts/AUDIT-SCOPE.md`).

## 1. Goal

Support the full autonomous-finance narrative (all six protocol layers) **and**
add machine-to-machine (M2M) agent commerce **now**, positioned as a first-class
participant in **Base's** ecosystem (x402 payments, Coinbase Smart Wallet / 4337
account abstraction, USDC settlement, on-chain proof).

## 2. Design principle (non-negotiable)

**Extend the spine; never fork the payment path.** Every money movement — ACH,
on-chain transfer, and the new x402/agent-commerce settlement — flows through
the same chain:

```
PaymentIntent  →  §6 deterministic gate  →  rail dispatch  →  audit (Merkle-anchored on Base)
```

The differentiator is not "another payment rail." It is **governed, provable
x402**: an autonomous machine payment that carries a deterministic policy
decision and an on-chain audit proof. Ungoverned x402 is a commodity; the gate +
audit are the moat — and M2M (autonomous, high-frequency, agent-initiated) is
exactly where that governance is most valuable.

**Anti-goal:** a separate "fast" un-gated path for agent micropayments. If
throughput is the concern, the answer is aggregation/streaming _into_ the gate
(§6.4), not around it.

## 3. What already exists (the foundation)

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
  Permissions** — see §6.5.)
- **Promotion** (`services/agent-router/src/promotion-config.ts`,
  `promotion.ts`): shadow-by-default; `LIVE_AGENTS` is the single allowlist;
  wired at `services/api/src/main.ts` (`isShadowed`, `checkRail`).
- **Audit** (`services/audit`): append-only, Merkle-chained, anchored on Base.
- **Reconciliation** (`services/ledger/src/reconciliation/`): includes a
  wallet-transfer matcher for on-chain settlement.

## 4. Layer-by-layer build plan

| Layer            | Net-new work for M2M + Base                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Raw / Ledger** | USDC/stablecoin accounting (balances, transactions); **agent counterparties** (a payee that is itself a registered agent); **escrow** as a new obligation/settlement type; on-chain settlement reconciliation matcher for x402/escrow. |
| **Wiki**         | No new role. Narrative memory of agent counterparties + job history (read projection only).                                                                                                                                            |
| **Policy**       | **Micropayment spend envelopes** + per-agent rate limits in the signed policy template; agent-counterparty **attestation/reputation as policy _inputs_** (informing thresholds, never replacing the deterministic gate).               |
| **Agent**        | x402/commerce agents promoted through the **same** shadow→readiness→live model; **ERC-8004**-style reputation as an additive `BrainMCPAgentRegistry` extension.                                                                        |
| **Execution**    | **New `x402` rail + action type** (§6.3); **Coinbase Smart Wallet / 4337 + CDP Paymaster** interop for gasless agent UX (§6.5); **escrow settlement** contract + rail.                                                                 |
| **Audit**        | The headline M2M feature — every machine payment provable on Base. Expose via the proof viewer + a settlement-proof resource.                                                                                                          |

## 5. New §6 gate checks (determinism preserved)

The gate gains checks; it does **not** gain discretion. Proposed additions
(numbered in the existing `1.5 / 7.5 / 9.5 / 11.5` "hardening addition" style so
they slot into the snapshot):

1. **x402 payment-context validation** — the x402 `paymentRequirements`
   (amount, asset=USDC, network=Base, recipient) match the PaymentIntent.
2. **Escrow-state binding** — for escrow settlements, the on-chain escrow lock
   state matches the intent (amount, parties, job id) before release.
3. **Agent-counterparty attestation** — when the payee is an agent, it is
   registered + attested in `BrainMCPAgentRegistry` and not paused.
4. **Micropayment cumulative cap** — per-agent rolling-window spend stays within
   the policy envelope (mirrors the on-chain session-key window cap, so the
   off-chain gate and on-chain contract agree).

Reputation may _raise or lower a policy threshold_ but must never _be_ the
precondition — LLM/reputation judgment stays out of the deterministic path
(Standards §6, Principle #5).

## 6. Component designs

### 6.1 PaymentIntent: new action type

Add `x402_settle` (and, if escrow is distinct, `escrow_release`) to
`ACTION_TYPES`. The invoice-shortcut-style resolver pattern (P0.5) resolves an
x402 payment request → `{ source_account_id, destination (agent counterparty),
amount, currency: "USDC" }`. Every field the gate needs is resolved up front and
re-validated by the gate at execute time.

### 6.2 Promotion / rail allowlist

- Add a promotion rail key `x402` (the short-key vocabulary used by
  `railKindForAction` in `main.ts`) and a `RailKind` value `x402_base` (the
  `Rail` interface vocabulary). Keep the two vocabularies explicitly mapped.
- A commerce agent ships as `LIVE_AGENTS = { …, commerce: [] }` (shadowed) and is
  promoted to `commerce: ["x402"]` only after `check-promotion-readiness`
  passes for it.

### 6.3 The `x402` rail

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

### 6.4 Throughput without bypass

For high-frequency agent payments, settle in **aggregated batches** or via a
**payment channel / streaming** primitive that still produces one gated
PaymentIntent per settlement window (not per micro-transaction). The gate runs on
the settlement, not on every sub-cent event. This preserves determinism + audit
while keeping per-payment cost viable.

### 6.5 Account model: two coexisting flows, one gate

- **Internal governed path** (Brain acting on a tenant's funds): keep the custom
  session-key `BrainSmartAccount`. It already encodes spend caps + policy-version
  binding and is simpler/auditable. **No 4337 rewrite here.**
- **Open ecosystem path** (external agents/wallets in Base's ecosystem): add a
  **4337 / Coinbase Smart Wallet–compatible** surface + **CDP Paymaster** for
  gasless agent UX. Coinbase **Spend Permissions** map closely onto Brain's
  session-key+cap model, easing convergence.
- Both paths terminate in the **same** PaymentIntent + §6 gate + audit.

### 6.6 Escrow settlement

A new on-chain escrow contract (lock → attest job completion → release/refund),
represented in the Ledger as an obligation/settlement type. Lock and release each
emit audit events and pass the gate (escrow-state-binding check, §5.2). **Audit
required before mainnet** (§8).

### 6.7 Reputation (ERC-8004)

Extend `BrainMCPAgentRegistry` (or a companion registry) with a reputation
pointer. It feeds Policy as **evidence/threshold input** only. It is explicitly
**not** a contract-level money gate and **not** a §6 precondition.

## 7. Sequencing (build now, safely)

Each step is shadow-launched and individually promotable:

1. **USDC ledger + on-chain settlement reconciliation** — the foundation;
   incremental on existing ledger/reconciliation/rail code.
2. **`x402` rail + `x402_settle` action type** through the gate (shadowed).
3. **Coinbase Smart Wallet / 4337 + CDP Paymaster** interop for gasless UX.
4. **Escrow contract + `escrow_release`** settlement type (post-audit).
5. **ERC-8004 reputation** as a Policy input.

Promotion of any money-moving agent stays gated by `check-promotion-readiness`
(H-24): outbox/RLS, gate checks, typed rail receipts, replay endpoint,
halt-category tests, adversarial coverage, on-chain behavior hash, session-key
grants.

## 8. Smart-contract safety

- New money contracts (x402 settlement, escrow) are added to
  `contracts/AUDIT-SCOPE.md` and **externally audited before mainnet**.
- Default posture stays **immutable** (CLAUDE.md: no upgradable contracts in
  MVP). If a deliberate upgrade path is wanted for fast-moving commerce
  primitives, it must be an explicit decision (timelock + multisig), audited —
  not the default. (See Decision D-3.)

## 9. Decisions needed (decision log)

| #       | Decision                                                      | Recommendation                                                                      |
| ------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **D-1** | Product framing: governance layer _and_ M2M commerce network? | **Both** (this RFC assumes it).                                                     |
| **D-2** | Adopt 4337 / Coinbase Smart Wallet for the open surface?      | **Yes, for the external surface only**; keep session keys internally.               |
| **D-3** | Upgradeable escrow/x402 contracts?                            | **Immutable by default**; timelock+multisig only if explicitly justified + audited. |
| **D-4** | Settlement asset for M2M?                                     | **USDC on Base** (x402-native).                                                     |
| **D-5** | Throughput model for micropayments?                           | **Aggregated/streamed settlement** through the gate (§6.4).                         |
| **D-6** | Reputation standard?                                          | **ERC-8004-style**, as a Policy input only.                                         |

## 10. Risks

- **Forking the payment path** (the cardinal risk) — mitigated by §2/§5: one
  gate, one audit trail.
- **Un-audited money contracts** — mitigated by §8.
- **Gate throughput** under M2M frequency — mitigated by §6.4 aggregation.
- **Counterparty trust** for agent payees — mitigated by the attestation check
  (§5.3) against the registry.
- **Doc/reality drift** re-opening — mitigated by §11 (promote to spec as each
  lands; don't let the narrative outrun the enforcement).

## 11. Documentation restructure (Shipped / In-Progress / Planned)

The published docs (docs.brain.fi, sourced from this repo's markdown) currently
describe parts of this vision as if shipped. With the vision now committed, the
fix is **status discipline**, not deletion: tag every relevant page and promote
it into the source-of-truth specs (OpenAPI / Standards / Architecture) as it
lands. Build to the spec, not the narrative.

| Doc area                                                       | Status today           | Action                                                                                                           |
| -------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Six-layer stack, gate, provenance, RLS, audit, propose≠execute | **Shipped**            | Reconcile stale facts (gate count = 13+4=17; anchor cadence = hourly; remove "Policy reads Wiki").               |
| MCP surface (9 tools, no execute)                              | **Shipped**            | Fix tool count (9), scopes (`execution:propose`), error codes, resource URIs.                                    |
| API reference (auth, errors, endpoints)                        | **Shipped (drifted)**  | Regenerate from `Brain_API_Specification.yaml` + `shared/src/errors.ts` + `scopes.ts`; remove phantom endpoints. |
| Session-key `BrainSmartAccount`                                | **Shipped**            | Replace the ERC-4337 `validateUserOp` description with the real session-key model.                               |
| x402 / agent commerce                                          | **Planned (this RFC)** | Mark **Planned**; build per §6–§7; promote to spec on landing.                                                   |
| Escrow / ERC-8183                                              | **Planned**            | Mark **Planned**; gated on §8 audit.                                                                             |
| ERC-8004 reputation                                            | **Planned**            | Mark **Planned**; Policy input only.                                                                             |
| 4337 / Coinbase Smart Wallet / paymaster                       | **Planned**            | Mark **Planned** for the open surface (§6.5).                                                                    |
| Proxy + timelock upgrades                                      | **Not planned (MVP)**  | Mark **Not in MVP**; revisit per D-3.                                                                            |

**Enforcement:** add a doc-drift CI check (precedent: `check-scope-vocab`,
`check-gate-bypass`) asserting (a) every endpoint named in `api-reference/*.md`
exists in the OpenAPI spec, and (b) numeric claims (gate count, anchor cadence)
match code constants. This is how the narrative stays honest as it grows.

## 12. Non-goals (for this RFC)

- Custody of funds (Brain remains non-custodial — reads, reasons, governs).
- Replacing the deterministic gate with reputation/LLM judgment.
- A parallel un-gated agent-payment path.
- Upgradeable contracts by default.
