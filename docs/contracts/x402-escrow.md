# BrainEscrow — x402 / M2M settlement escrow (design + audit scope)

- **Status:** Draft — **UNAUDITED reference implementation. NOT FOR MAINNET.**
- **Date:** 2026-05-27
- **Source of truth:** RFC 0001 §7.6 (escrow), §3 (on-chain privacy), §9 (contract safety)
- **Contracts:** `contracts/src/IBrainEscrow.sol`, `contracts/src/BrainEscrow.sol`
- **Tests:** `contracts/test/BrainEscrow.t.sol`

> ⚠️ **Audit gate.** Per RFC 0001 §9 ("Audit required before mainnet") and Brain's
> non-negotiable invariant — _no money contract reaches mainnet without an
> external security audit_ — `BrainEscrow` is a pre-audit reference
> implementation. It may be deployed to **Base Sepolia (testnet) only**. The
> contract is immutable (no admin, no upgrade, no pause), so the audit must
> complete before any mainnet address is funded.

## 1. Purpose

`BrainEscrow` is the on-chain settlement venue for agent-to-agent (M2M) commerce
where a payment must be **conditioned on job completion** rather than settled
immediately. A payer locks USDC against a hashed commitment of the job terms; the
funds release to the payee when the job is attested complete, or refund to the
payer on timeout / dispute.

It does **not** create a second money path. Every escrow lock and release still
originates from a `PaymentIntent` that passes the **§6 deterministic gate** and is
audited (RFC 0001 §2 — never fork the payment path). The contract is the
settlement primitive; Brain's off-chain spine remains the control plane.

## 2. Data model — hash-only (RFC 0001 §3)

On-chain we store **only** what is non-reversible-to-PII:

| Field          | Type      | Notes                                                      |
| -------------- | --------- | ---------------------------------------------------------- |
| `escrowId`     | `bytes32` | Caller-chosen unique id (e.g. keccak of the x402 request). |
| `payer`        | `address` | Funder (buyer/agent).                                      |
| `payee`        | `address` | Beneficiary on release (seller/agent).                     |
| `token`        | `address` | ERC-20 settled — USDC on Base (D-4).                       |
| `amount`       | `uint256` | Locked amount (token base units).                          |
| `jobTermsHash` | `bytes32` | keccak256 **commitment** of the off-chain job terms.       |
| `deadline`     | `uint64`  | Unix seconds; after it the payer may self-refund.          |
| `state`        | `enum`    | `None / Locked / Released / Refunded`.                     |

There is **no `string` anywhere on the ABI** — enforced by
`scripts/check-no-onchain-pii.mjs` in CI. Job descriptions, invoices, identities,
and amounts-in-context never touch the chain; only the commitment hash does. This
keeps Brain GDPR-compatible against an immutable, un-erasable ledger.

## 3. State machine

```
            lock()                 release()  (payer | arbiter)
   None ───────────────▶ Locked ─────────────────────────────▶ Released  (terminal)
                            │
                            │       refund()   (arbiter any time |
                            └─────────────────  payer after deadline) ──▶ Refunded (terminal)
```

- An `escrowId` is **single-use**: once it leaves `None` it can never return, so a
  settled id cannot be replayed.
- `Released` and `Refunded` are terminal — an escrow settles **exactly once**
  (no release-then-refund, no double release).

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

1. **Solvency / funds conservation** — the contract's token balance always equals
   the sum of currently-`Locked` amounts. Funds are never created or destroyed;
   every deposit is held, released to the payee, or refunded to the payer
   (`invariant_solvency`).
2. **Settle-once** — a `Locked` escrow transitions to exactly one terminal state;
   double-release and release-then-refund both revert (`EscrowNotLocked`).
3. **Authorization** — only payer/arbiter release; only arbiter (or payer
   after deadline) refunds; strangers revert (`NotAuthorized` /
   `DeadlineNotReached`).
4. **Reentrancy-safe** — a `nonReentrant` latch plus checks-effects-interactions
   (terminal state set **before** the external token transfer). A malicious token
   that reenters `release` during its `transfer` cannot double-spend (proven with
   a reentrant-token test).
5. **SafeERC20 semantics** — transfers tolerate both bool-returning (USDC) and
   no-return ERC-20s and revert on failure (`TransferFailed`).
6. **Replay-safe ids** — see §3.

## 6. Relationship to the rest of Brain

- **§6 gate (escrow-state binding).** RFC 0001 §6 lists an _escrow-state-binding_
  check (deferred from Phase 2B). When wired, the gate reads `getEscrow(escrowId)`
  and binds the `PaymentIntent` to the on-chain lock — amount, parties, and
  `jobTermsHash` must match before a release is gated through. `getEscrow` exposes
  exactly those fields for that purpose. **TODO(brain-hardening):** add the
  escrow-state-binding gate check + its loader (mirrors checks 6.5/3.5).
- **x402 rail vs escrow.** The simple x402 settlement (immediate USDC transfer)
  uses the existing session-key `BrainSmartAccount` path (RFC 0001 §7.5) — no new
  contract. `BrainEscrow` is only for _conditional_ settlement (job must complete
  first). Both terminate in the same PaymentIntent → §6 gate → audit flow.
- **Ledger.** An escrow lock/release maps to an obligation/settlement in the
  Ledger; the on-chain `release` tx hash is the `chain_tx_hash` the
  `onchain_settlement` reconciliation matcher (Phase 1A) reconciles against.

## 7. External-audit scope (RFC 0001 §9)

Before any mainnet deployment an external auditor must review at minimum:

1. **Fund custody & accounting** — solvency invariant under all interleavings;
   no path that strands or double-counts funds.
2. **Reentrancy & external-call safety** — the guard + CEI ordering, and the
   low-level `call`-based transfer wrapper (return-data handling, gas).
3. **Authorization** — the payer/arbiter/deadline matrix; confirm no missing
   `onlyX` path and that the immutable arbiter cannot be abused (it can release
   to the _designated_ payee or refund to the _designated_ payer only — it can
   never redirect funds to an arbitrary address).
4. **ERC-20 compatibility** — USDC specifics (6 decimals, bool return), and
   fee-on-transfer / rebasing tokens (out of scope for USDC, but document the
   assumption: only standard, non-fee tokens are supported).
5. **Griefing / DoS** — unbounded loops (none), id collisions, deadline edge
   cases (`>=` semantics).
6. **Immutability** — confirm no admin, no upgrade, no `selfdestruct`, no
   `delegatecall`.

## 8. Explicitly out of scope (this pass)

- ERC-4337 / Coinbase Smart Wallet / paymaster interop (RFC 0001 §7.5 — Phase 4).
- Partial release / milestone payments, multi-asset escrows, on-chain dispute
  arbitration beyond the single arbiter.
- Mainnet deployment (audit-gated) and the §6 escrow-state-binding gate check
  (separate follow-up).
