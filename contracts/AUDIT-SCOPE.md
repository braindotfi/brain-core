# Smart contract audit scope

Scope package for the external audit of Brain's four Solidity contracts (Foundry,
Solidity ≥0.8.24, no upgradeable proxies in MVP). Total ~933 LoC. Each contract
below lists its size, the invariants the auditor must verify, known hardening
additions, and existing test coverage.

Commit under audit: **TODO(brain-hardening): pin the audited commit SHA + tag.**

---

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

- This scope doc + the four contracts + `contracts/test/*.t.sol` (unit + fuzz +
  invariant) + gas baselines.
- `Brain_MVP_Architecture.md` (§Layer 6 audit anchor, §Layer 5 smart account) and
  `Brain_Engineering_Standards.md` §8.3 for context.
- The off-chain counterpart (`services/audit/src/merkle.ts`) so the auditor can
  confirm on-/off-chain hashing parity.
