# BrainEscrow. X402 / M2M settlement escrow (design + audit scope)

- **Status:** Draft. **UNAUDITED reference implementation. NOT FOR MAINNET.**
- **Date:** 2026-05-27
- **Source of truth:** RFC 0001 §7.6 (escrow), §3 (on-chain privacy), §9 (contract safety)
- **Contracts:** `contracts/src/IBrainEscrow.sol`, `contracts/src/BrainEscrow.sol`
- **Tests:** `contracts/test/BrainEscrow.t.sol`

> ⚠️ **Audit gate.** Per RFC 0001 §9 ("Audit required before mainnet") and Brain's
> non-negotiable invariant. _no money contract reaches mainnet without an
> external security audit_. `BrainEscrow` is a pre-audit reference
> implementation. It may be deployed to **Base Sepolia (testnet) only**. The
> contract is immutable (no admin, no upgrade, no pause), so the audit must
> complete before any mainnet address is funded.

## 1. Purpose

`BrainEscrow` is the on-chain settlement venue for agent-to-agent (M2M) commerce
where a payment must be **conditioned on job completion** rather than settled
immediately. A payer locks USDC against a hashed commitment of the job terms; the
funds release to the payee when the job is attested complete, or refund to the
payer on timeout / dispute.

Settlement is **incremental**: `release` and `refund` each move a partial amount
(`amount` ≤ remaining), so a single lock supports **milestone payments** (release
in stages as work lands) and **arbiter dispute-splits** (release part to the
payee, refund the rest to the payer). The escrow stays `Locked` until
`released + refunded` reaches the full locked `amount`, at which point it becomes
`Settled` (terminal). An id therefore settles **exactly once in aggregate**, never
in a single mandatory all-or-nothing move.

It does **not** create a second money path. Every escrow lock and release still
originates from a `PaymentIntent` that passes the **§6 deterministic gate** and is
audited (RFC 0001 §2. Never fork the payment path). The contract is the
settlement primitive; Brain's off-chain spine remains the control plane.

## 2. Data model. Hash-only (RFC 0001 §3)

On-chain we store **only** what is non-reversible-to-PII:

| Field          | Type      | Notes                                                      |
| -------------- | --------- | ---------------------------------------------------------- |
| `escrowId`     | `bytes32` | Caller-chosen unique id (e.g. keccak of the x402 request). |
| `payer`        | `address` | Funder (buyer/agent).                                      |
| `payee`        | `address` | Beneficiary on release (seller/agent).                     |
| `token`        | `address` | ERC-20 settled. USDC on Base (D-4).                       |
| `amount`       | `uint256` | Total locked amount (token base units).                    |
| `released`     | `uint256` | Cumulative amount transferred to the payee.                |
| `refunded`     | `uint256` | Cumulative amount returned to the payer.                   |
| `jobTermsHash` | `bytes32` | keccak256 **commitment** of the off-chain job terms.       |
| `deadline`     | `uint64`  | Unix seconds; after it the payer may self-refund.          |
| `state`        | `enum`    | `None / Locked / Settled`.                                 |

`remaining = amount - released - refunded` is the unsettled balance (derived, not
stored). Each `release` / `refund` is bounded by `remaining`; the escrow flips to
`Settled` exactly when `remaining` reaches 0.

There is **no `string` anywhere on the ABI**. Enforced by
`scripts/check-no-onchain-pii.mjs` in CI. Job descriptions, invoices, identities,
and amounts-in-context never touch the chain; only the commitment hash does. This
keeps Brain GDPR-compatible against an immutable, un-erasable ledger.

## 3. State machine

```
                       release(amt)  (payer | arbiter)  ─┐  each ≤ remaining;
                       refund(amt)   (arbiter | payer    │  escrow stays Locked
            lock()                    after deadline)    │  while remaining > 0
   None ───────────────▶ Locked ◀───────────────────────┘
                            │
                            │  when released + refunded == amount
                            ▼
                         Settled  (terminal)
```

- An `escrowId` is **single-use**: once it leaves `None` it can never return, so a
  settled id cannot be replayed.
- `release` and `refund` are **incremental**. Each moves `amount ≤ remaining`
  and the escrow stays `Locked` while `remaining > 0`. This is what enables
  milestone payments and dispute-splits (mix releases and refunds on one lock).
- `Settled` is terminal. Reached exactly when `released + refunded == amount`.
  After it, any further `release` / `refund` reverts (`EscrowNotLocked`). Total
  out ≤ `amount` always, so an escrow can never over-pay.

## 4. Authorization matrix

| Action    | payer                        | arbiter      | anyone else   |
| --------- | ---------------------------- | ------------ | ------------- |
| `lock`    | ✅ (becomes the payer)       | n/a          | ✅ (as payer) |
| `release` | ✅ (confirms delivery)       | ✅ (attests) | ❌            |
| `refund`  | ✅ **only after `deadline`** | ✅ (dispute) | ❌            |

The `arbiter` is set once at construction and is **immutable** (a Safe multi-sig
in production). It is Brain's attester / dispute resolver. There is deliberately
**no admin** that can drain or redirect funds.

## 5. Security properties (asserted in tests)

1. **Solvency / funds conservation**. The contract's token balance always equals
   the sum of every escrow's outstanding (`amount - released - refunded`) balance,
   under any interleaving of locks and **partial** releases. Funds are never
   created or destroyed; every deposit is held, released to the payee, or refunded
   to the payer (`invariant_solvency`, with a partial-release handler).
2. **No over-payment / settle-once-in-aggregate**. Each `release` / `refund` is
   bounded by `remaining` (`AmountExceedsRemaining` otherwise), so cumulative
   `released + refunded` can never exceed `amount`. Once it equals `amount` the
   escrow is `Settled` and every further `release` / `refund` reverts
   (`EscrowNotLocked`). No double-spend past the locked total.
3. **Authorization**. Only payer/arbiter release; only arbiter (or payer
   after deadline) refunds; strangers revert (`NotAuthorized` /
   `DeadlineNotReached`). The arbiter can split a disputed lock (partial release +
   partial refund) but only ever to the **designated** payee / payer. Never to an
   arbitrary address.
4. **Reentrancy-safe**. A `nonReentrant` latch plus checks-effects-interactions
   (terminal state set **before** the external token transfer). A malicious token
   that reenters `release` during its `transfer` cannot double-spend (proven with
   a reentrant-token test).
5. **SafeERC20 semantics**. Transfers tolerate both bool-returning (USDC) and
   no-return ERC-20s and revert on failure (`TransferFailed`).
6. **Replay-safe ids**. See §3.

## 6. Relationship to the rest of Brain

- **§6 gate (escrow-state binding, check 6.6).** The gate reads
  `getEscrow(escrowId)` and binds the `PaymentIntent` to the on-chain lock before
  a release is gated through: still `Locked`, enough **remaining** balance to
  cover this release (`remaining >= intent.amount`. _not_ an exact match against
  the total `amount`, which would reject every milestone after the first), same
  payee (== the counterparty's on-chain address), same `jobTermsHash`. The chain
  read is injected (`resolveEscrowState`); the gate in `@brain/shared` never
  touches the chain. The shared type contract is `shared/src/gate/escrow-binding.ts`
  (`ResolvedEscrowState` carries `amount` / `released` / `refunded` / `remaining`).
  The on-chain reader itself (BrainEscrow.getEscrow via viem) is the deferred
  live-wiring. **TODO(brain-hardening):** implement `resolveEscrowState` in
  services/policy.
- **x402 rail vs escrow.** The simple x402 settlement (immediate USDC transfer)
  uses the existing session-key `BrainSmartAccount` path (RFC 0001 §7.5). No new
  contract. `BrainEscrow` is only for _conditional_ settlement (job must complete
  first). Both terminate in the same PaymentIntent → §6 gate → audit flow.
- **Ledger.** An escrow lock/release maps to an obligation/settlement in the
  Ledger; the on-chain `release` tx hash is the `chain_tx_hash` the
  `onchain_settlement` reconciliation matcher (Phase 1A) reconciles against.

## 7. External-audit scope (RFC 0001 §9)

Before any mainnet deployment an external auditor must review at minimum:

1. **Fund custody & accounting**. Solvency invariant under all interleavings;
   no path that strands or double-counts funds.
2. **Reentrancy & external-call safety**. The guard + CEI ordering, and the
   low-level `call`-based transfer wrapper (return-data handling, gas).
3. **Authorization**. The payer/arbiter/deadline matrix; confirm no missing
   `onlyX` path and that the immutable arbiter cannot be abused (it can release
   to the _designated_ payee or refund to the _designated_ payer only. It can
   never redirect funds to an arbitrary address).
4. **ERC-20 compatibility**. USDC specifics (6 decimals, bool return), and
   fee-on-transfer / rebasing tokens (out of scope for USDC, but document the
   assumption: only standard, non-fee tokens are supported).
5. **Griefing / DoS**. Unbounded loops (none), id collisions, deadline edge
   cases (`>=` semantics).
6. **Immutability**. Confirm no admin, no upgrade, no `selfdestruct`, no
   `delegatecall`.

## 8. Explicitly out of scope (this pass)

- ERC-4337 / Coinbase Smart Wallet / paymaster interop (RFC 0001 §7.5. Phase 4).
- Multi-asset escrows (one lock = one token; D-4 is USDC-only) and on-chain
  dispute arbitration beyond the single arbiter (the arbiter resolves disputes
  off-chain and settles via partial release + refund).
- Mainnet deployment (audit-gated) and the live `resolveEscrowState` on-chain
  reader that wires gate check 6.6 (separate follow-up).

> **Now in scope (this revision):** partial release / refund. Milestone payments
> and arbiter dispute-splits. The gate's escrow-state binding (check 6.6) and its
> shared types were updated to bind against `remaining` rather than the total
> locked `amount`.
