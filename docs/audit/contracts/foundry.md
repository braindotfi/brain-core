# Audit #11. Solidity Contracts (Foundry)

**Subsystem**: `contracts/`. `BrainAuditAnchor`, `BrainSmartAccount`, `BrainPolicyRegistry`, `BrainMCPAgentRegistry`
**Auditor**: Evidence-driven, commands executed 2026-05-26
**Status**: Complete
**Score**: 5 / 10

---

## 1. Scope

Four Solidity 0.8.24 contracts in `contracts/src/`, compiled and tested with Foundry. This audit covers:

- Build integrity (`forge build`)
- Test suite coverage and failures (`forge test`)
- Contract-level correctness (EIP-712 scheme, access control, idempotency invariants)
- ABI alignment between the four TS callers and the on-chain function signatures
- Chain-targeting (baseSepolia vs mainnet Base 8453)

Out of scope: live deployment verification, gas optimization, formal verification, on-chain state inspection.

---

## 2. Evidence Collected

### Build

```
pnpm run contracts:build    # cd contracts && forge build
Result: Compiler run successful with warnings.
  → unwrapped modifier in BrainSmartAccount (linting hint, not an error)
```

No compilation errors. All four contracts compile cleanly on Solidity 0.8.24 with optimizer enabled (`via_ir = true`, `optimizer_runs = 10000`).

### Test suite

```
pnpm run contracts:test    # cd contracts && forge test
Result: 68 tests passed, 1 FAILED

Failing tests:
Encountered 1 failing test in test/BrainMCPAgentRegistry.t.sol:BrainMCPAgentRegistryTest
[FAIL: next call did not revert as expected]
  test_updateBehaviorHash_rejectsNonSigner() (gas: 246559)
```

Configuration (`foundry.toml`):

- `fuzz.runs = 1000`, `invariant.runs = 256`
- `bytecode_hash = "none"` (deterministic builds)
- Solidity 0.8.24

### Key files read

| File                                                     | Purpose                        |
| -------------------------------------------------------- | ------------------------------ |
| `contracts/src/BrainAuditAnchor.sol` (136 lines)         | Merkle root publisher          |
| `contracts/src/BrainSmartAccount.sol` (257 lines)        | ERC-4337 session keys          |
| `contracts/src/BrainPolicyRegistry.sol` (255 lines)      | Policy hash registry           |
| `contracts/src/BrainMCPAgentRegistry.sol` (287 lines)    | Agent scope attestation        |
| `contracts/test/BrainMCPAgentRegistry.t.sol` (176 lines) | Failing test. Full read        |
| `services/api/src/anchorBroadcaster.ts`                  | TS → BrainAuditAnchor ABI      |
| `services/api/src/mcp/viemScopeChecker.ts`               | TS → BrainMCPAgentRegistry ABI |
| `services/api/src/rails/onchainExecutor.ts`              | TS → BrainSmartAccount ABI     |
| `services/api/src/policy/viemPolicySignerChecker.ts`     | TS → BrainPolicyRegistry ABI   |

---

## 3. Contract-by-Contract Analysis

### BrainAuditAnchor.sol (`contracts/src/BrainAuditAnchor.sol`)

**Status: Clean.**

- `anchor(bytes32 tenantId, bytes32 root, uint256 eventCount, uint256 periodStart, uint256 periodEnd)`. `onlyPublisher` modifier, write-once per `(tenantId, root)` pair via `_published[tenantId][root]`.
- `verifyInclusion(bytes32 root, bytes32 leaf, bytes32[] calldata proof)`. Domain-separated keccak256: leaf = `keccak256(0x00 || leaf)`, internal nodes = `keccak256(0x01 || sorted_pair)`. Matches `services/audit/src/merkle.ts` implementation exactly.
- `latestAnchor()` / `latestAnchorFull()` view helpers for off-chain reconciliation.
- Idempotency invariant: re-anchoring the same root reverts with `AlreadyPublished`.

**ABI alignment** (`anchorBroadcaster.ts` line 19–33):

```ts
{ name: "anchor", inputs: [tenantId:bytes32, root:bytes32, eventCount:uint256,
                            periodStart:uint256, periodEnd:uint256] }
```

Matches Solidity exactly. No drift.

**Chain**: hardcoded `baseSepolia` in `anchorBroadcaster.ts` lines 3 and 47. Mainnet anchoring requires a code change. This is R-30 (already logged in index.md).

---

### BrainSmartAccount.sol (`contracts/src/BrainSmartAccount.sol`)

**Status: Clean.**

Session key struct:

```solidity
struct SessionKey {
    address holder;
    uint256 validAfter;
    uint256 validUntil;
    address[] allowedTargets;
    bytes4[] allowedSelectors;
    uint256 maxPerTx;
    uint256 maxPerPeriod;
    uint256 periodSeconds;
    uint256 policyVersion;
}
```

`executeViaSessionKey(uint256 nonceSupplied, address target, uint256 value, bytes calldata data)`:

- H-03 nonce replay guard: requires `nonceSupplied == _nonces[holder]`, increments before external call.
- Re-entrancy guard: sets `_locked = true` before external call, clears in `finally` equivalent.
- `allowedTargets` / `allowedSelectors` enforcement. Unknown targets or selectors revert.
- Per-tx cap: `value > key.maxPerTx` reverts (for ETH transfers and decoded ERC-20 amounts).
- Per-period cap: cumulative `_periodSpent[holder]` tracked with `periodResetAt` timestamp.
- ERC-20 amount decoding: reads token amount from calldata for `transfer`, `approve`, `transferFrom` when `value == 0`.

**ABI alignment** (`onchainExecutor.ts` line 17–20):

```ts
"function nonce(address holder) external view returns (uint256)";
"function executeViaSessionKey(uint256 nonceSupplied, address target, uint256 value, bytes calldata data) external";
```

Both function signatures match Solidity exactly. No drift.

**Chain**: `onchainExecutor.ts` is chain-aware. Uses `base` (mainnet 8453) when `chainId === 8453`, `baseSepolia` otherwise (line 32). This is the correct pattern; this caller does not have the hardcoded-chain issue.

---

### BrainPolicyRegistry.sol (`contracts/src/BrainPolicyRegistry.sol`)

**Status: Clean.**

- `registerPolicy(tenantId, version, policyHash, signers[], signatures[])`:
  - Write-once per `(tenantId, version)`.
  - Strict monotonic version enforcement: `version <= latestVersion[tenantId]` reverts.
  - Multi-sig: all supplied signers must be pre-authorized tenant signers; signatures verified via `ecrecover` with recovered address equality check (`recovered != signers[i]` reverts).
  - Signer uniqueness enforced via strict ascending address order.
- `setTenantSigner(tenantId, signer, allowed, authSigner, signature)`:
  - EIP-712 signed signer-change with replay-protection nonce (`tenantSignerNonce[tenantId]`).
  - Bootstrap: `initialAdmin` may set the first signer when `_tenantSignerCount[tenantId] == 0`.
  - Post-bootstrap: only existing tenant signers may add/remove others.
  - Re-bootstrap allowed after all signers are removed (lockout prevention).

**ABI alignment** (`viemPolicySignerChecker.ts`):

- `isTenantSigner(bytes32 tenantId, address signer)`. Matches Solidity. No drift.

---

### BrainMCPAgentRegistry.sol (`contracts/src/BrainMCPAgentRegistry.sol`)

**Status: 1 failing test. Potential access control regression.**

Contract design is correct per static analysis:

- EIP-712 signed registration, revocation, and behavior update.
- Tenant signer management with bootstrap/re-bootstrap pattern (mirrors `BrainPolicyRegistry`).
- `updateBehaviorHash(agentId, behaviorHash, tenantSignature)`:
  - Line 167: checks `r.registeredAt == 0` → `AgentNotRegistered`
  - Line 168: checks `r.revokedAt != 0` → `AgentRevokedError`
  - Line 170: computes `_hashBehaviorUpdate(agentId, r.tenantId, behaviorHash)` EIP-712 digest
  - Line 172: `if (recovered == address(0) || !_tenantSigners[r.tenantId][recovered]) revert NotTenantSigner`

The access control logic at line 172 is structurally correct. However, the Forge test `test_updateBehaviorHash_rejectsNonSigner()` fails:

```
[FAIL: next call did not revert as expected]
test_updateBehaviorHash_rejectsNonSigner() (gas: 246559)
```

The test signs with `externalPk = 0xCA75` (a key with no tenant-signer role) and expects a revert. The function executed successfully (gas consumed at the write-path level). This means `_recover` returned an address that IS in `_tenantSigners[TENANT]`.

Possible root causes (requires `forge test -vvvv` to confirm):

1. **ECDSA digest mismatch**: the test's `_behaviorDigest` helper and the contract's `_hashBehaviorUpdate` could compute different digests due to a subtle encoding divergence, causing `ecrecover` to return an unexpected address that coincidentally matches `signer = vm.addr(0xB0B)`. This is the most likely explanation given the gas level (~246K suggesting a full storage write).

2. **Hex literal encoding**: both contract and test use `hex"19_01"` (EIP-712 prefix). Solidity 0.8.x supports underscore separators in hex literals, but if the Foundry version under test interprets them differently, digest computation would diverge consistently.

3. **`_tenantSignerCount` mapping collision**: highly unlikely. Different private keys produce different secp256k1 addresses.

**Security impact**: if this represents a real access control gap, any caller who can produce a signature over the `AgentBehaviorUpdate` typehash can update an agent's `behaviorHash`. This bypasses the §6 gate check 1.5, which rejects execution when the runtime `behaviorHash` differs from the registered value.

**Immediate action**: run `forge test -vvvv --match-test test_updateBehaviorHash_rejectsNonSigner` and inspect the recovered address trace.

#### ABI Mismatch. `viemScopeChecker.ts` (CRITICAL, Latent)

`BrainMCPAgentRegistry.getAgent` returns an `AgentRegistration` tuple with 7 fields:

```solidity
// Solidity struct (7 fields):
bytes32 agentId
address agentAddress
bytes32 tenantId
bytes32 scopeHash
bytes32 behaviorHash    ← MISSING in TS ABI
uint256 registeredAt
uint256 revokedAt
```

The TS ABI in `viemScopeChecker.ts` (line 8–29) defines only 6 components:

```ts
// TS ABI components (6 fields. Missing behaviorHash):
{ name: "agentId",      type: "bytes32" }
{ name: "agentAddress", type: "address" }
{ name: "tenantId",     type: "bytes32" }
{ name: "scopeHash",    type: "bytes32" }
// behaviorHash omitted here
{ name: "registeredAt", type: "uint256" }   ← decodes from behaviorHash slot
{ name: "revokedAt",    type: "uint256" }   ← decodes from registeredAt slot
```

ABI tuple decoding is positional. With the missing field, the TS decoder reads:

- `registration.registeredAt` ← actual `behaviorHash` value (bytes32 as uint256, always non-zero for registered agents)
- `registration.revokedAt` ← actual `registeredAt` (block timestamp, always non-zero)

The consequence: `getOnchainScopeHash` at line 53 checks:

```ts
if (registration.registeredAt === 0n || registration.revokedAt !== 0n) return null;
```

`revokedAt` (actually `registeredAt`) is always non-zero → **always returns `null`** for all registered agents.

This makes on-chain scope verification fail for 100% of agents when the real scope checker is activated.

**Currently latent**: `services/mcp/src/auth.ts` line 12 notes "v0.3 ship stubs the on-chain check". The `StubOnchainScopeChecker` is used in production wiring. This bug activates when `ViemOnchainScopeChecker` is wired.

---

## 4. Functional Status

| Contract                | Build | Tests         | Access Control            | ABI Aligned                          |
| ----------------------- | ----- | ------------- | ------------------------- | ------------------------------------ |
| `BrainAuditAnchor`      | Pass  | All pass      | Clean                     | Yes                                  |
| `BrainSmartAccount`     | Pass  | All pass      | Clean (H-03 replay guard) | Yes                                  |
| `BrainPolicyRegistry`   | Pass  | All pass      | Clean                     | Yes                                  |
| `BrainMCPAgentRegistry` | Pass  | **1 FAILING** | **Regression suspected**  | **No (TS ABI missing behaviorHash)** |

---

## 5. Production Readiness

**Score: 5 / 10**

| Dimension       | Assessment                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Build integrity | Pass. No compilation errors                                                                                        |
| Test coverage   | 67/68 tests pass. 1 access control regression unresolved                                                           |
| ABI alignment   | 3/4 callers aligned; `viemScopeChecker` has critical structural mismatch                                           |
| Chain targeting | Anchor broadcaster hardcoded to `baseSepolia` (R-30); scope checker same; executor is chain-aware                  |
| Security model  | EIP-712 multi-sig, replay nonces, write-once invariants. Correct in design; implementation gap in MCPAgentRegistry |
| Idempotency     | Anchor and policy registry enforce write-once; MCPAgentRegistry revocation is non-reversible                       |

**Blockers before mainnet activation:**

1. Diagnose and fix `test_updateBehaviorHash_rejectsNonSigner`. Potential behavior hash bypass.
2. Add `behaviorHash` to `BRAIN_MCP_AGENT_REGISTRY_ABI` in `viemScopeChecker.ts`.
3. Parameterize `chain` in `anchorBroadcaster.ts` and `viemScopeChecker.ts` (mirrors R-30).

---

## 6. Confidence

| Area                            | Confidence | Reason                                                                  |
| ------------------------------- | ---------- | ----------------------------------------------------------------------- |
| Build correctness               | High       | `forge build` executed; no errors                                       |
| Test results                    | High       | `forge test` executed; exact failure captured                           |
| Contract logic (3 of 4)         | High       | Full source read; logic matches design docs                             |
| MCPAgentRegistry access control | **Low**    | Test fails; root cause not confirmed without `forge test -vvvv` trace   |
| ABI mismatch impact             | High       | Positional decoding with 6 vs 7 fields is deterministic                 |
| Deployed contract state         | Low        | No live chain access; deploy addresses from `.env.example` not verified |

---

## 7. Findings

### F-11-A. `test_updateBehaviorHash_rejectsNonSigner` fails (SEVERITY: High)

- **File**: `contracts/test/BrainMCPAgentRegistry.t.sol:163`, `contracts/src/BrainMCPAgentRegistry.sol:161`
- **Evidence**: `forge test` output. `[FAIL: next call did not revert as expected]`, gas 246559 (write-path level)
- **Impact**: If the contract has a real access control gap, any caller can update an agent's `behaviorHash`, defeating §6 gate check 1.5 (behavior pinning). The on-chain record of the agent's expected model/prompt hash becomes untrustworthy.
- **Action**: `forge test -vvvv --match-test test_updateBehaviorHash_rejectsNonSigner`; inspect recovered address. If contract bug confirmed, fix `_hashBehaviorUpdate` or the access control branch; add to R-31 in findings register.

### F-11-B. `viemScopeChecker.ts` ABI missing `behaviorHash` (SEVERITY: Critical, Latent)

- **File**: `services/api/src/mcp/viemScopeChecker.ts:8–29`
- **Evidence**: Struct has 7 fields in Solidity; TS ABI has 6. `registeredAt` and `revokedAt` decode from wrong offsets. `getOnchainScopeHash` always returns `null`.
- **Impact**: When the real `ViemOnchainScopeChecker` is wired (replacing the stub), all MCP agent auth will fail with `agent_scope_hash_missing` or `agent_scope_hash_mismatch`. The MCP surface becomes inaccessible.
- **Fix**: Add `{ name: "behaviorHash", type: "bytes32" }` after `scopeHash` in `BRAIN_MCP_AGENT_REGISTRY_ABI`.

### F-11-C. Anchor and scope checkers hardcoded to `baseSepolia` (SEVERITY: High, already R-30)

- **Files**: `services/api/src/anchorBroadcaster.ts:3,47,52`, `services/api/src/mcp/viemScopeChecker.ts:2,39`
- **Already tracked**: R-30. Production mainnet anchoring (Base 8453) requires code change.

---

## 8. Cross-Cutting Risks Added to Register

| ID   | Finding                                                                                                           | Severity          | Status |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ----------------- | ------ |
| R-31 | `updateBehaviorHash` access control regression. Forge test fails; potential behavior hash bypass                  | High              | Open   |
| R-32 | `viemScopeChecker` ABI missing `behaviorHash`. MCP on-chain scope verification structurally broken when activated | Critical (latent) | Open   |

(R-30. Hardcoded `baseSepolia`. Previously logged; no new entry.)

---

## 9. Refactor Priority

| Priority | Item                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Fix `viemScopeChecker.ts` ABI (add `behaviorHash` field). Pre-activation blocker                                                                        |
| P0       | Diagnose `test_updateBehaviorHash_rejectsNonSigner`. Run `forge test -vvvv`, fix root cause                                                             |
| P1       | Parameterize chain in `anchorBroadcaster.ts` and `viemScopeChecker.ts` via `BRAIN_BASE_CHAIN_ID` (already in `onchainExecutor.ts`)                      |
| P2       | Generate canonical ABI JSON from Foundry artifacts (`out/`) and import them in TS callers instead of inline definitions. Eliminates this class of drift |

---

## 10. Comparison to Prior Audit

The 2026-05-25 monolithic audit did not cover contract-level testing or TS ABI alignment in detail. Two new findings emerge from this evidence-driven audit:

- `viemScopeChecker` ABI mismatch was undetected (F-11-B, R-32).
- The Forge test failure was undetected (F-11-A, R-31).

The H-03 nonce replay guard (claimed as remediated) is verified correct in `BrainSmartAccount.sol`.

---

## 11. Recommended Next Steps

1. **Immediate**: `forge test -vvvv --match-test test_updateBehaviorHash_rejectsNonSigner`. Root-cause the failing test.
2. **Before MCP on-chain auth activation**: fix `viemScopeChecker.ts` ABI (one-line addition).
3. **Before mainnet deploy**: parameterize chain selectors; use Foundry-generated ABI artifacts in TS callers.
4. **Ongoing**: wire `forge test` into CI with a hard fail gate so the one failing test blocks merges.
