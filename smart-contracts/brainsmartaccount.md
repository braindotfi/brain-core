# BrainSmartAccount

`BrainSmartAccount` is a per-tenant ERC-4337 smart account that validates UserOperations against the tenant's active policy and the proposing agent's scope attestation.

A UserOp is valid if and only if **all four** of the following are true:

| Check                                                                       | Source                                |
| --------------------------------------------------------------------------- | ------------------------------------- |
| 1. Agent address is registered for the tenant                               | `BrainMCPAgentRegistry`               |
| 2. Agent presents a valid, non-expired EIP-712 ScopeAttestation             | Signed by the tenant                  |
| 3. The off-chain Policy verdict attached to the UserOp evaluates to `ALLOW` | Signed by Brain's policy verifier key |
| 4. The action falls within global account-level limits                      | On-chain `AccountLimits`              |

### Implementation

```solidity
contract BrainSmartAccount is BaseAccount {
    bytes32 public tenantId;
    address public policyVerifier;   // off-chain Brain key
    IBrainMCPAgentRegistry public registry;

    struct AccountLimits {
        uint128 perTx;
        uint128 perDay;
        uint64  dayStart;
        uint128 spentToday;
    }
    AccountLimits public limits;

    function _validateSignature(
        UserOperation calldata userOp,
        bytes32 userOpHash
    ) internal override returns (uint256 validationData) {
        (bytes memory scopeAtt, bytes memory policyVerdict)
            = abi.decode(userOp.signature, (bytes, bytes));

        require(_isRegisteredAgent(userOp.sender), "agent not registered");
        require(_verifyScope(userOp, scopeAtt), "scope invalid");
        require(_verifyPolicy(userOpHash, policyVerdict), "policy denied");
        require(_withinLimits(userOp), "limits exceeded");
        return 0;
    }

    // EIP-7702 path: existing EOA can delegate to this implementation
    // for a single-session lifetime, with the same checks above.
}
```

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

### Policy Verdicts

The Policy verdict is signed off-chain by the Brain policy verifier key registered in the smart account.

| Property        | Value                                   |
| --------------- | --------------------------------------- |
| **Default TTL** | 60 seconds                              |
| **Bound to**    | The specific `userOpHash`               |
| **Signed by**   | `policyVerifier`                        |
| **Replayable?** | No, single-use against this UserOp only |

{% hint style="warning" %}
A policy verdict for one UserOp cannot be used to validate any other UserOp. Even if a verdict is intercepted, it expires within 60 seconds and can only be used against the exact `userOpHash` it was bound to.
{% endhint %}

### Account-Level Limits

Global limits cap blast radius even when policy and scope are valid.

| Field                    | Purpose                               |
| ------------------------ | ------------------------------------- |
| `perTx`                  | Maximum value of a single transaction |
| `perDay`                 | Maximum cumulative value per UTC day  |
| `dayStart`, `spentToday` | Rolling daily counter, reset per day  |

`_withinLimits()` rejects UserOps that would exceed either ceiling.

### EIP-7702 Path

For tenants who own an EOA and want smart-account semantics for a single session:

| Step | What Happens                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------- |
| 1    | Tenant signs an EIP-7702 authorization delegating execution to `BrainSmartAccount`'s implementation |
| 2    | The authorization is included in a UserOp                                                           |
| 3    | During validation, the same scope, policy, and limits checks run                                    |
| 4    | The session expires when the authorization's validity window ends                                   |

This lets existing EOAs use Brain without redeploying as a new account.

### Belt-and-Braces Enforcement

Policy is enforced **twice** by design.

| Layer                       | When                 | Catches                                                                   |
| --------------------------- | -------------------- | ------------------------------------------------------------------------- |
| **Off-chain Policy Engine** | At proposal time     | Most violations, fast feedback, dynamic conditions                        |
| **`BrainSmartAccount`**     | At UserOp validation | Anything the off-chain engine missed; protects against backend compromise |

Even if the off-chain backend is compromised, on-chain validation rejects UserOps without a valid, non-expired, scope-bound policy verdict.

### Threat Scenarios

| Scenario                                            | Outcome                                          |
| --------------------------------------------------- | ------------------------------------------------ |
| Agent submits UserOp with no scope attestation      | Reverts: "scope invalid"                         |
| Agent uses an expired scope                         | Reverts: `notAfter` check fails                  |
| Backend submits UserOp with no policy verdict       | Reverts: "policy denied"                         |
| Backend replays an old verdict against a new UserOp | Reverts: verdict bound to wrong `userOpHash`     |
| Compromised key tries to submit beyond limits       | Reverts: "limits exceeded"                       |
| Replays a session-key call with a consumed nonce    | Reverts: `BadNonce`                              |
| Malicious target re-enters `executeViaSessionKey`   | Reverts: `ReentrantCall`                         |
| Owner grants a key with an empty allowlist          | Reverts: `TargetsRequired` / `SelectorsRequired` |

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
