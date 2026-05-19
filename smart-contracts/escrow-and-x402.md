# Escrow and x402

Where an external agent is paid for its work, Brain coordinates settlement **without ever custodying funds**. Two standards do the heavy lifting: ERC-8183 for escrowed jobs, x402 for HTTP-native machine payments.

| Standard     | Use Case                                                                |
| ------------ | ----------------------------------------------------------------------- |
| **ERC-8183** | Job-style work where payment releases on verified completion            |
| **x402**     | Per-call API access where payment settles inline with each HTTP request |

### ERC-8183 escrowed job flow

The tenant locks payment. The agent does the work. Brain co-signs the release. Funds settle to the agent.

```
1. Tenant proposes a job
        │
        ↓
2. BrainSmartAccount locks payment in escrow
        │
        ↓
3. Agent executes the work
        │
        ↓
4. Agent submits a completion attestation
        │
        ↓
5. Brain (neutral verifier) co-signs release
        │
        ↓
6. Funds settle to agent's address
```

If verification fails, funds return to the tenant after a timeout.

| Phase       | What Happens                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Lock**    | Tenant's smart account transfers funds into the escrow contract; the entry references `agent`, `capability`, `actionId`, and a deadline |
| **Work**    | Agent performs the action, off-chain or on-chain                                                                                        |
| **Attest**  | Agent submits a signed completion attestation                                                                                           |
| **Verify**  | Brain validates the attestation against the action receipt                                                                              |
| **Settle**  | If valid, Brain co-signs release; funds settle to the agent                                                                             |
| **Timeout** | If the deadline passes without valid completion, funds return to the tenant                                                             |

{% hint style="success" %}
Brain is a **neutral verifier**, not a custodian. Funds move directly between the tenant's account and the agent's address. Brain signs that the work was done; it does not hold the money in transit.
{% endhint %}

### EIP-712 attestation type

```
JobCompletion(
  bytes32 actionId,
  address agent,
  bytes32 resultHash,
  uint64  timestamp,
  uint256 nonce
)
```

| Field        | Purpose                                |
| ------------ | -------------------------------------- |
| `actionId`   | The action this completion attests to  |
| `resultHash` | Hash of the work output (audit-linked) |
| `timestamp`  | Used to enforce job deadline           |
| `nonce`      | Replay protection                      |

### Dispute resolution

If the agent and tenant disagree on whether work was completed:

| Path                                                 | Outcome                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| **Agent submits valid attestation, tenant disputes** | Brain reviews evidence; can co-sign release or hold pending arbitration |
| **Agent fails to submit before deadline**            | Funds return to tenant automatically                                    |
| **Brain detects fraud**                              | Release blocked; reputation slashed against agent's `reputationRoot`    |

### x402 machine-native payments

For HTTP-native settlement, Brain integrates **x402**: the resource server returns `402 Payment Required` with payment instructions; the calling agent retries with an x402 payment header backed by the tenant's smart account; settlement and audit happen in the same flow.

```
Agent                      Resource Server
  │                              │
  │  GET /api/data               │
  │ ──────────────────────────►  │
  │                              │
  │  402 Payment Required        │
  │  X-Payment-Required: ...     │
  │ ◄──────────────────────────  │
  │                              │
  │  GET /api/data               │
  │  X-Payment: ...              │
  │ ──────────────────────────►  │
  │                              │
  │  200 OK + result             │
  │ ◄──────────────────────────  │
```

| Step                     | Detail                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| **Initial request**      | Agent calls a resource without payment                                                  |
| **402 response**         | Server returns required amount, recipient address, currency                             |
| **Retry with X-Payment** | Agent attaches a payment authorization signed against its smart account                 |
| **Validate and settle**  | Server validates the payment (or accepts a verifiable promise) and returns the resource |
| **Audit**                | The full flow is logged as an audit event linked to the action                          |

### When to use which

| Scenario                                | Standard                                |
| --------------------------------------- | --------------------------------------- |
| Agent paid on completion of a job       | ERC-8183                                |
| Agent pays per-call for an API or tool  | x402                                    |
| Agent pays another agent for a sub-task | x402 (immediate) or ERC-8183 (deferred) |

### Where settlement is **not** Brain's job

| Boundary          | Who Handles                                    |
| ----------------- | ---------------------------------------------- |
| Funds in transit  | Tenant's smart account or rail; not Brain      |
| Final settlement  | The settlement layer (Base, an off-chain rail) |
| Tax and reporting | Tenant and tenant's accounting tooling         |

Brain coordinates and proves; it does not hold.

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>The smart account that locks and releases.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr><tr><td><strong>🪪 BrainMCPAgentRegistry</strong></td><td>How agent reputation accumulates.</td><td><a href="brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr><tr><td><strong>🤖 Agents</strong></td><td>The conceptual model.</td><td><a href="../concepts/agents.md">agents.md</a></td><td></td></tr></tbody></table>
