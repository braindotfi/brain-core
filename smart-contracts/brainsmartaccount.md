# BrainSmartAccount

`BrainSmartAccount` is a per-tenant **session-key smart account**. The tenant's root key owns the account; Brain receives a scoped, spend-capped, revocable **session key**. The owner calls `grantSessionKey` to issue a key, and the session-key holder calls `executeViaSessionKey(nonce, target, value, data)` to dispatch a call — the account enforces every bound on-chain and reverts on anything out of scope.

A session-key call succeeds if and only if **all** of the following hold, checked inside `executeViaSessionKey`:

| Check                                                                                | Mechanism                   |
| ------------------------------------------------------------------------------------ | --------------------------- |
| 1. Caller is the granted holder, and the key is not paused                           | `holder` match + pause flag |
| 2. The call is within the key's validity window (`validAfter`/`validUntil`)          | Per-key timestamps          |
| 3. The supplied nonce equals the holder's current replay nonce                       | Per-holder `nonce(holder)`  |
| 4. `target` is on the key's `allowedTargets` allowlist                               | Per-key target allowlist    |
| 5. The calldata selector is on the key's `allowedSelectors` allowlist                | Per-key selector allowlist  |
| 6. The amount is within the per-tx (`maxPerTx`) and per-window (`maxPerPeriod`) caps | On-chain spend caps         |

The key's `policyVersion` is bound at grant time (a zero value is rejected by `grantSessionKey`), so a stored key always carries the policy digest it was authorized under.

### Implementation

```solidity
contract BrainSmartAccount {
    struct SessionKey {
        address holder;
        uint256 validAfter;
        uint256 validUntil;
        address[] allowedTargets;
        bytes4[] allowedSelectors;
        uint256 maxPerTx;       // per-call value cap (wei)
        uint256 maxPerPeriod;   // cumulative cap per periodSeconds window (wei)
        uint256 periodSeconds;  // e.g. 86400 for daily; 0 disables period accounting
        bytes32 policyVersion;  // bound at grant; must be non-zero
    }

    address public owner;             // tenant root key (hardware/custody)
    bytes32 public immutable tenantId;
    address public immutable policyRegistry;

    // Owner-only: issue a scoped, spend-capped, policyVersion-bound key.
    function grantSessionKey(SessionKey calldata key) external onlyOwner;

    // Holder-authenticated: execute within the key's bounds, or revert.
    function executeViaSessionKey(
        uint256 nonceSupplied,
        address target,
        uint256 value,
        bytes calldata data
    ) external returns (bytes memory result);

    // Kill-switch / lifecycle, all owner-only.
    function pauseSessionKey(address holder) external;
    function unpauseSessionKey(address holder) external;
    function revokeSessionKey(address holder) external;
}
```

`executeViaSessionKey` walks the target and selector allowlists, derives the cap-relevant amount (decoding ERC20 `transfer`/`approve`/`transferFrom` quantities so a `value == 0` token transfer cannot bypass the caps), enforces the per-tx and per-window caps, checks-effects-interactions the external call, increments the replay nonce, and emits `AgentActionExecuted`. There is no off-chain verdict signature on the call path; the policy decision is made off-chain and reflected in the key's `policyVersion` binding and scope.

### EIP-712 ScopeAttestation

The agent's signature includes a tenant-signed scope attestation.

```
ScopeAttestation(
  bytes32 tenantId,
  address agent,
  bytes32 capability,        // e.g. keccak256("pay_invoice")
  uint128 maxAmount,
  bytes32 resourceScope,     // e.g. counterparty allowlist root
  uint64  notBefore,
  uint64  notAfter,
  uint256 nonce
)
```

| Field                   | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `capability`            | The action class the agent may take             |
| `maxAmount`             | Per-action ceiling (denominated per token)      |
| `resourceScope`         | Allowlist root (counterparties, accounts, etc.) |
| `notBefore`, `notAfter` | Validity window                                 |
| `nonce`                 | Per-tenant, per-agent replay protection         |

### Policy Binding

The off-chain Policy decision is reflected on-chain by the key's `policyVersion`, fixed when the owner grants the key.

| Property          | Value                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| **Bound at**      | Grant time, in `grantSessionKey`                                      |
| **Bound to**      | The key holder, via the stored `policyVersion` digest                 |
| **Zero allowed?** | No, `grantSessionKey` reverts `PolicyVersionMismatch` on `bytes32(0)` |
| **Anchored in**   | `BrainPolicyRegistry` (the digest the off-chain decision used)        |

{% hint style="warning" %}
A session key carries exactly the `policyVersion` it was granted under. Rotating the active policy means granting a fresh key; the old key keeps its original binding until revoked or expired.
{% endhint %}

### Spend Caps

Per-key caps bound blast radius even within the key's allowlists.

| Field           | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `maxPerTx`      | Maximum value of a single call                                          |
| `maxPerPeriod`  | Maximum cumulative value per `periodSeconds` window                     |
| `periodSeconds` | Window length for the cumulative cap (e.g. `86400` daily; `0` disables) |

`executeViaSessionKey` reverts `ExceedsPerTxCap` or `ExceedsPerPeriodCap` on a call that would breach either ceiling, tracking spend per holder per window.

### Belt-and-Braces Enforcement

Policy is enforced **twice** by design.

| Layer                       | When                      | Catches                                                                   |
| --------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| **Off-chain Policy Engine** | At proposal time          | Most violations, fast feedback, dynamic conditions                        |
| **`BrainSmartAccount`**     | At `executeViaSessionKey` | Anything the off-chain engine missed; protects against backend compromise |

Even if the off-chain backend is compromised, on-chain enforcement rejects any call outside the granted session key's policyVersion-bound scope, allowlists, and spend caps.

### Threat Scenarios

| Scenario                                          | Outcome                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| Holder calls a target outside the allowlist       | Reverts: `TargetNotAllowed`                        |
| Holder calls a selector outside the allowlist     | Reverts: `SelectorNotAllowed`                      |
| Call exceeds the per-tx or per-window cap         | Reverts: `ExceedsPerTxCap` / `ExceedsPerPeriodCap` |
| Call made before/after the key's validity window  | Reverts: `KeyNotActive`                            |
| Call made while the key is paused                 | Reverts: `KeyPaused`                               |
| Replays a session-key call with a consumed nonce  | Reverts: `BadNonce`                                |
| Malicious target re-enters `executeViaSessionKey` | Reverts: `ReentrantCall`                           |
| Owner grants a key with an empty allowlist        | Reverts: `TargetsRequired` / `SelectorsRequired`   |
| Owner grants a key with a zero `policyVersion`    | Reverts: `PolicyVersionMismatch`                   |

## Kill-Switch: Pause vs Revoke

| Function                    | Effect                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pauseSessionKey(holder)`   | Immediately disables execution by this session key **without** deleting its record, window spend, limits, or metadata — so `unpauseSessionKey(holder)` resumes with no fresh attestation. Idempotent, owner-only. |
| `unpauseSessionKey(holder)` | Re-enables execution under the key's existing scope and accumulated window spend.                                                                                                                                 |
| `revokeSessionKey(holder)`  | **Permanent** removal — deletes the key record entirely (and clears any pause flag).                                                                                                                              |

`executeViaSessionKey` reverts with `KeyPaused` while a key is paused. This backs the off-chain `/v1/agents/{id}/halt` and `/v1/payment-intents/{id}/pause` flows.

### Per-Task Minimum-Privilege Keys

A one-time child key is granted per approved PaymentIntent, bounded to the **exact** counterparty (`allowedTargets`), **exact** amount (`maxPerTx == maxPerPeriod`), and a \~10-minute `validUntil`. A compromised worker can spend at most one in-flight intent's authority.

### Session-Key Hardening (pre-audit)

`executeViaSessionKey` carries three defenses closing pre-audit weaknesses:

| Defense                   | Mechanism                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Non-empty scope**       | `grantSessionKey` reverts (`TargetsRequired` / `SelectorsRequired`) on an empty target or selector allowlist — an empty list no longer means "any"                                    |
| **Policy bound at grant** | A zero `policyVersion` is rejected at grant (`PolicyVersionMismatch`), so a stored key can never have a missing policy binding                                                        |
| **Replay nonce**          | `executeViaSessionKey(nonceSupplied, target, value, data)` reverts `BadNonce(expected, supplied)` unless `nonceSupplied == nonce(holder)`, then increments — every call is single-use |
| **Re-entrancy guard**     | A per-holder `_locked` flag is set before the external call and cleared after; a target that calls back in reverts `ReentrantCall`                                                    |

The off-chain rail reads the current `nonce(holder)` and threads it into the call (see the on-chain Base rail). Caps and allowlists are still enforced on every call as before.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🪪 BrainMCPAgentRegistry</strong></td><td>Where agent identity is checked.</td><td><a href="brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr><tr><td><strong>📋 BrainPolicyRegistry</strong></td><td>Where the active policy hash is anchored.</td><td><a href="brainpolicyregistry.md">brainpolicyregistry.md</a></td><td></td></tr><tr><td><strong>🤖 Agents</strong></td><td>The conceptual model.</td><td><a href="../concepts/agents.md">agents.md</a></td><td></td></tr></tbody></table>
