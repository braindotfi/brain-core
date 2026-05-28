# BrainReputationRegistry. ERC-8004 agent reputation pointer (design + audit scope)

- **Status:** Draft. **UNAUDITED reference implementation.** Non-custodial.
- **Date:** 2026-05-27
- **Source of truth:** RFC 0001 §7.7 (reputation), §3 (on-chain privacy), §9 (contract safety), D-6
- **Contracts:** `contracts/src/IBrainReputationRegistry.sol`, `contracts/src/BrainReputationRegistry.sol`
- **Tests:** `contracts/test/BrainReputationRegistry.t.sol`
- **Off-chain consumer:** `services/policy/src/reputation.ts`

> ⚠️ **Status note.** `BrainReputationRegistry` is **non-custodial**. It holds no
> funds and has no token / value transfer path of any kind, so it is **not a
> "money contract"** in the RFC 0001 §9 sense and an unaudited deploy risks no
> money. It is nonetheless **batched into the external audit** (correctness of the
> monotonic epoch, attestor authorization, hash-only ABI) and runs on **Base
> Sepolia (testnet) only** until that audit clears. Immutable. No upgrade, no
> pause; the only privileged action is attestor rotation (attestor-only).

## 1. Purpose

`BrainReputationRegistry` is Brain's ERC-8004-style on-chain home for **agent
reputation** in the M2M / x402 commerce surface. For each agent it records a
single **reputation pointer**. A `bytes32` Merkle root that commits to the
agent's off-chain reputation dataset (feedback, attestations, the inputs a score
is derived from). Versioned by a monotonically increasing `epoch`.

Two things it deliberately is **not**:

1. **Not raw history / not a score.** The chain holds the _pointer_ only (RFC 0001
   §3: "only a pointer / Merkle root on-chain"). The numeric reputation score is
   derived off-chain from the dataset the root commits to. No PII, no feedback
   text, no per-counterparty detail ever touches calldata.
2. **Not a money gate and not a §6 precondition.** Reputation feeds the **Policy**
   layer as a _threshold_ input. It may make a decision **stricter** for a
   low-reputation counterparty (more approvers, a lower cap, verification at a
   lower amount). It can never authorize a payment, and the deterministic §6
   pre-execution gate never consumes a reputation value (Standards §6, Principle
   #5: reputation / LLM judgment never replaces a deterministic gate check). See
   `services/policy/src/reputation.ts`. The off-chain adjustment is **tighten-only**.

## 2. Data model. Hash-only (RFC 0001 §3)

Per agent (`agentId`, the same `bytes32` keccak identifier used by
`BrainMCPAgentRegistry`) the registry stores exactly:

| Field       | Type      | Notes                                                       |
| ----------- | --------- | ----------------------------------------------------------- |
| `scoreRoot` | `bytes32` | Merkle root committing to the off-chain reputation dataset. |
| `epoch`     | `uint64`  | Monotonic version; strictly increases on each publish.      |
| `updatedAt` | `uint64`  | Unix seconds of the latest publication (`block.timestamp`). |

There is **no `string` anywhere on the ABI**. The surface is `bytes32` /
`address` / `uint` only, enforced by `scripts/check-no-onchain-pii.mjs` in CI.

## 3. Update model. Monotonic epoch

```
   publishReputation(agentId, scoreRoot, epoch)   (attestor only)
   ─ requires scoreRoot != 0
   ─ requires epoch > current epoch   (StaleEpoch otherwise)
   ─ overwrites the pointer + bumps updatedAt
```

- **Anti-replay / total ordering.** Each publish must strictly increase the
  agent's `epoch`; a stale or equal epoch reverts (`StaleEpoch`). An old pointer
  can therefore never overwrite a newer one, even if the attestor key is induced
  to re-broadcast a prior message.
- **First publish** requires `epoch >= 1` (the default epoch is 0, and `0 <= 0`
  is stale). A non-zero `epoch` is the "has reputation" marker (`hasReputation`).
- **Revocation / reset** is expressed off-chain: the attestor publishes a new
  root (at a higher epoch) that commits to the revoked/empty dataset. There is no
  on-chain "clear" (a zero root reverts, `ZeroRoot`).

## 4. Authorization

| Action                | attestor | anyone else        |
| --------------------- | -------- | ------------------ |
| `publishReputation`   | ✅       | ❌ (`NotAttestor`) |
| `setAttestor`         | ✅       | ❌ (`NotAttestor`) |
| `reputationOf` (view) | ✅       | ✅ (public read)   |

The `attestor` (Brain's reputation oracle; a Safe multi-sig in production) is the
only writer. It is rotatable **only by the current attestor** (`setAttestor`,
itself access-controlled). The same controlled-rotation pattern as
`BrainAuditAnchor`'s publisher. There is no admin, no upgrade, no pause. Crucially
the attestor has **no fund-moving power**. The registry has no value path. So a
compromised attestor can at worst publish a bad reputation pointer, which (by the
Policy tighten-only rule) can only make payments _stricter_, never authorize one.

## 5. Security properties (asserted in tests)

1. **Monotonic epoch / no regression**. The stored `epoch` always equals the
   maximum published epoch for an agent and never decreases under any interleaving
   of publishes; the stored root is always the most-recent non-zero root
   (`invariant_epochTracksGhostAndRootNonZero`, with a randomized handler).
2. **Anti-replay**. Any `epoch <= current` reverts (`StaleEpoch`); proven by
   unit (`equal` / `lower`) and fuzz (`testFuzz_staleEpochAlwaysReverts`).
3. **Authorization**. Only the attestor publishes / rotates; strangers revert
   (`NotAttestor`). After rotation the old key loses rights and the new key gains
   them.
4. **Hash-only / no PII (RFC §3)**. ABI is `bytes32` / `address` / `uint` only;
   a non-zero root is required (`ZeroRoot`). Enforced by
   `scripts/check-no-onchain-pii.mjs`.
5. **Non-custodial**. No `transfer` / `transferFrom` / `call` / `payable` / value
   path exists; the contract can neither hold nor move funds.

## 6. Relationship to the rest of Brain

- **Policy (tighten-only threshold input).** `services/policy/src/reputation.ts`
  consumes a `ReputationScore { score, source }` via an injected
  `ReputationResolver`. The on-chain `scoreRoot` is the opaque `source` pointer;
  the numeric `score` is derived off-chain from the dataset the root commits to.
  `applyReputationAdjustment` can only ADD approvers / LOWER caps. Never loosen a
  control, never turn a reject into an allow. The **live on-chain reader** (read
  `reputationOf(agentId)` via viem) is the deferred wiring step. **TODO(brain-hardening):**
  implement the `ReputationResolver` against this registry.
- **§6 gate.** The gate never sees a reputation value. Policy folds reputation
  into the (already-adjusted) thresholds the gate then enforces deterministically.
- **ERC-8004 / Base ecosystem.** `reputationOf` is a public read, so other Base
  participants can fetch an agent's reputation pointer. The interop surface RFC
  0001 §7.7 calls for, without exposing Brain's private reputation data.

## 7. External-audit scope (batched)

Although non-money, the registry is included in the external audit. Review:

1. **Monotonic-epoch correctness**. No path lets a stale/equal epoch overwrite a
   newer pointer; no off-by-one strands an agent at a wrong epoch; overflow
   behavior at the `uint64` ceiling.
2. **Authorization**. `onlyAttestor` on both `publishReputation` and
   `setAttestor`; rotation cannot lock out or be hijacked; the zero-address guard.
3. **Hash-only ABI**. Confirm no `string` / PII surface and that the only writable
   datum is a `bytes32` commitment.
4. **Confirm non-custodial**. No value path, no `selfdestruct` / `delegatecall`,
   no admin / upgrade / pause; a compromised attestor cannot move funds (there are
   none) and, via Policy's tighten-only rule, cannot weaken a payment control.
5. **Immutability**. Same posture as the other Brain contracts (D-3: immutable by
   default).

## 8. Explicitly out of scope (this pass)

- On-chain score computation / aggregation (derived off-chain; only the root is
  anchored).
- Decentralized / multi-attestor feedback (single trusted attestor in MVP, per
  D-6).
- The live `ReputationResolver` on-chain reader in services/policy (deferred
  wiring, mirrors escrow's deferred `resolveEscrowState`).
- Any use of reputation as a money gate or a §6 precondition. **prohibited by
  design** (Standards §6, Principle #5), not merely deferred.
