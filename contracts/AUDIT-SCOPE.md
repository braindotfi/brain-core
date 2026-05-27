# Smart contract audit scope

Scope package for the external audit of Brain's five Solidity contracts (Foundry,
Solidity ≥0.8.24, no upgradeable proxies in MVP). Total ~1,200 LoC. Each contract
below lists its size, the invariants the auditor must verify, known hardening
additions, and existing test coverage.

> **Highest priority: `BrainEscrow`.** It is the only contract that **custodies
> user funds** (USDC), and it is the gate for Phase 5 (first real governed
> machine payment on mainnet). It is currently **UNAUDITED / Base Sepolia
> testnet-only** and immutable; it must clear this audit before any mainnet
> address is funded (RFC 0001 §9). Audit it first and most thoroughly.

Commit under audit: **TODO(brain-hardening): pin the audited commit SHA + tag.**

---

## BrainEscrow (132 LoC impl + 56 LoC `IBrainEscrow` interface) — PRIORITY

Conditional x402 / M2M settlement escrow (RFC 0001 §7.6): a payer locks USDC
against a hashed job commitment; funds **release** to the payee on attested
completion, or **refund** to the payer on timeout / arbiter dispute. Settlement is
**incremental** — `release(amount)` and `refund(amount)` each move a partial
amount (`≤ remaining`), supporting **milestone payments** and **arbiter
dispute-splits** (release part to the payee, refund the rest to the payer). State
machine: `None → Locked → Settled`, where `Settled` is reached exactly when
`released + refunded == amount` (terminal). The **only** funds-custodying contract
— treat as the highest-severity surface. The partial-settlement accounting
(`released` / `refunded` accumulators, the `remaining` bound) is **new since the
last revision** and deserves focused attention.

Design + threat model + the audit-scope rationale: `docs/contracts/x402-escrow.md`.

**Critical invariants:**

- **Solvency / funds conservation:** the contract's token balance always equals
  the sum of every escrow's outstanding (`amount - released - refunded`) balance.
  No interleaving of lock and **partial** release/refund strands or double-counts
  funds (`invariant_solvency`, exercised with a partial-release handler).
- **No over-payment / settle-once-in-aggregate + replay-safe ids:** every
  `release` / `refund` is bounded by `remaining` (`AmountExceedsRemaining`
  otherwise), so cumulative `released + refunded` can never exceed `amount`. Once
  it equals `amount` the escrow is `Settled` and any further `release` / `refund`
  reverts (`EscrowNotLocked`); an `escrowId` is single-use (a settled id can never
  be reused). The auditor should confirm no rounding / off-by-one lets the sum
  exceed `amount` or strand the last unit.
- **Authorization:** only `payer` or `arbiter` may `release`; only `arbiter`
  (any time) or `payer` after `deadline` may `refund`; everyone else reverts
  (`NotAuthorized` / `DeadlineNotReached`). Crucially, the **immutable** arbiter
  can only release to the _designated_ payee or refund to the _designated_ payer
  (including across a partial dispute-split) — it can NEVER redirect funds to an
  arbitrary address, and there is no admin / drain / upgrade / pause /
  `selfdestruct` / `delegatecall` path.
- **Reentrancy-safe:** a `nonReentrant` latch plus checks-effects-interactions
  (terminal state set _before_ the external token transfer). A malicious token
  that reenters `release` during its `transfer` cannot double-spend.
- **SafeERC20 semantics:** the low-level transfer wrapper tolerates both
  bool-returning (USDC) and no-return ERC-20s and reverts on a false/failed
  return (`TransferFailed`).
- **Hash-only / no PII (RFC §3):** the ABI is `bytes32` / `address` / `uint`
  only — the sole job datum on-chain is `jobTermsHash` (a keccak commitment).
  Enforced by `scripts/check-no-onchain-pii.mjs`.

**Hardening:** `nonReentrant` + CEI ordering; single-use escrow ids; an immutable
arbiter with no fund-redirection power; a dependency-free SafeERC20-style wrapper
(inline `IERC20Minimal`, no external libs).

**Documented assumptions the auditor should confirm:**

- Settlement token is **USDC on Base** — a standard ERC-20 (6 decimals, bool
  return). **Fee-on-transfer / rebasing tokens are out of scope** (the design
  assumes `amount` received == `amount` transferred).
- `arbiter` is a Safe multi-sig in production, trusted to attest completion /
  resolve disputes — but, per the authorization invariant, never able to
  redirect funds.

**Coverage** (`contracts/test/BrainEscrow.t.sol`): unit (full release settles,
**partial milestone** releases keep `Locked` until drained, byArbiter,
refund pre/post deadline, **arbiter partial refund-then-release** and a
**dispute-split** (release 70% + refund 30%), over-`remaining` rejection
(`AmountExceedsRemaining`), release-after-`Settled` rejection, stranger/auth
rejections, zero-amount, unknown-id), **fuzz**
(`testFuzz_lockReleaseConservesFunds`), **invariant** (`invariant_solvency` with a
partial-release handler), and a **reentrancy** test (a reentrant token cannot
double-spend).

## BrainAuditAnchor (135 LoC)

Append-only Merkle-root anchor for the audit log; `verifyInclusion` is the
public verification primitive.

**Critical invariants:**

- A published Merkle root for a (tenant, period) cannot be re-published or
  overwritten.
- Only the configured publisher can `anchor`; publisher rotation is itself
  access-controlled.
- `verifyInclusion(root, leaf, proof)` is byte-identical to the off-chain
  builder (`services/audit/src/merkle.ts`): `leaf = keccak256(0x00‖leaf)`,
  `node = keccak256(0x01‖sort(l,r))`. A valid proof verifies; any single-byte
  mutation of root/leaf/proof fails.
- No state mutation path for an already-anchored root.

**Coverage:** unit (anchor records/emits, duplicate-root rejection, period
validation, publisher rotation) + `verifyInclusion` single/pair/wrong-proof +
the P1.3 fuzz invariant `testFuzz_verifyInclusion_tamperFails`.

## BrainPolicyRegistry (255 LoC)

On-chain registry of signed policy versions (content hash + EIP-712 attestation).

**Critical invariants:**

- A policy version's stored content hash matches the signed attestation; a
  tampered policy fails signature/content-hash verification.
- Only an authorized signer can register/activate a version (EIP-712, with the
  low-`s` malleability guard present in the code).
- Version monotonicity / no silent downgrade of the active version.

**Hardening:** EIP-712 signature with the canonical low-`s` check
(`s ≤ secp256k1n/2`).

**Coverage:** unit + fuzz per external function; invariant "registered versions
carry a content hash matching the stored policy."

## BrainSmartAccount (256 LoC)

ERC-4337-style smart account; the payment agent executes on-chain via a session
key under a deterministic gate.

**Critical invariants (H-03 hardening):**

- **Replay protection:** every `execute` consumes the current per-holder nonce;
  a replayed/stale nonce reverts.
- **Re-entrancy:** the external call is guarded by a per-holder re-entrancy lock.
- A revoked session key cannot execute.
- Owner rotation is access-controlled (hardware-wallet swap path).

**Hardening:** H-03 added the per-holder replay nonce + re-entrancy guard.

**Coverage:** unit (execute happy path, owner rotation, session-key revoke) +
fuzz + invariant "a revoked session key cannot execute."

## BrainMCPAgentRegistry (287 LoC)

On-chain registration of external MCP agents with an EIP-712 scope attestation.

**Critical invariants:**

- A registered agent's stored `scope_hash` matches the signed scope attestation;
  a mutated scope hash fails verification (the MCP auth chain depends on this).
- Only the agent's controlling key can register/rotate; EIP-712 with the low-`s`
  malleability guard.
- Revocation is honored (a revoked agent cannot pass scope-hash validation).

**Coverage:** unit + fuzz per external function; invariant "registered agents
have a `scope_hash` matching stored scope."

---

## What the auditor receives

- This scope doc + the five contracts (incl. `BrainEscrow.sol` +
  `IBrainEscrow.sol`) + `contracts/test/*.t.sol` (unit + fuzz + invariant) + gas
  baselines.
- `docs/contracts/x402-escrow.md` — the `BrainEscrow` design, state machine,
  authorization matrix, security properties, and external-audit scope.
- `Brain_MVP_Architecture.md` (§Layer 6 audit anchor, §Layer 5 smart account) and
  `Brain_Engineering_Standards.md` §8.3 for context.
- The off-chain counterpart (`services/audit/src/merkle.ts`) so the auditor can
  confirm on-/off-chain hashing parity.
- Build/test reproduction: `forge build --sizes` + `forge test -vvv` from
  `contracts/` (Solidity 0.8.24, deterministic build — `bytecode_hash = none`,
  `cbor_metadata = false`; fuzz 1000 / invariant 256×64 per `foundry.toml`).
