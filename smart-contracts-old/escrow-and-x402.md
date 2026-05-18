# Escrow and x402

Where an external agent is paid for its work, Brain coordinates settlement **without ever custodying funds**. Two standards do the heavy lifting: ERC-8183 for escrowed jobs, x402 for HTTP-native machine payments.

<table><thead><tr><th width="150">Standard</th><th>Use Case</th></tr></thead><tbody><tr><td><strong>ERC-8183</strong></td><td>Job-style work where payment releases on verified completion</td></tr><tr><td><strong>x402</strong></td><td>Per-call API access where payment settles inline with each HTTP request</td></tr></tbody></table>

### ERC-8183 Escrowed Job Flow

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

<table><thead><tr><th width="150">Phase</th><th>What Happens</th></tr></thead><tbody><tr><td><strong>Lock</strong></td><td>Tenant's smart account transfers funds into the escrow contract; the entry references <code>agent</code>, <code>capability</code>, <code>actionId</code>, and a deadline</td></tr><tr><td><strong>Work</strong></td><td>Agent performs the action, off-chain or on-chain</td></tr><tr><td><strong>Attest</strong></td><td>Agent submits a signed completion attestation</td></tr><tr><td><strong>Verify</strong></td><td>Brain validates the attestation against the action receipt</td></tr><tr><td><strong>Settle</strong></td><td>If valid, Brain co-signs release; funds settle to the agent</td></tr><tr><td><strong>Timeout</strong></td><td>If the deadline passes without valid completion, funds return to the tenant</td></tr></tbody></table>

{% hint style="success" %}
Brain is a **neutral verifier**, not a custodian. Funds move directly between the tenant's account and the agent's address. Brain signs that the work was done; it does not hold the money in transit.
{% endhint %}

### EIP-712 Attestation Type

```
JobCompletion(
  bytes32 actionId,
  address agent,
  bytes32 resultHash,
  uint64  timestamp,
  uint256 nonce
)
```

<table><thead><tr><th width="200">Field</th><th>Purpose</th></tr></thead><tbody><tr><td><code>actionId</code></td><td>The action this completion attests to</td></tr><tr><td><code>resultHash</code></td><td>Hash of the work output (audit-linked)</td></tr><tr><td><code>timestamp</code></td><td>Used to enforce job deadline</td></tr><tr><td><code>nonce</code></td><td>Replay protection</td></tr></tbody></table>

### Dispute Resolution

If the agent and tenant disagree on whether work was completed:

| Path                                                 | Outcome                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| **Agent submits valid attestation, tenant disputes** | Brain reviews evidence; can co-sign release or hold pending arbitration |
| **Agent fails to submit before deadline**            | Funds return to tenant automatically                                    |
| **Brain detects fraud**                              | Release blocked; reputation slashed against agent's `reputationRoot`    |

### x402 Machine-Native Payments

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

<table><thead><tr><th width="249">Step</th><th>Detail</th></tr></thead><tbody><tr><td><strong>Initial request</strong></td><td>Agent calls a resource without payment</td></tr><tr><td><strong>402 response</strong></td><td>Server returns required amount, recipient address, currency</td></tr><tr><td><strong>Retry with X-Payment</strong></td><td>Agent attaches a payment authorization signed against its smart account</td></tr><tr><td><strong>Validate and settle</strong></td><td>Server validates the payment (or accepts a verifiable promise) and returns the resource</td></tr><tr><td><strong>Audit</strong></td><td>The full flow is logged as an audit event linked to the action</td></tr></tbody></table>

### When to Use Which

| Scenario                                | Standard                                |
| --------------------------------------- | --------------------------------------- |
| Agent paid on completion of a job       | ERC-8183                                |
| Agent pays per-call for an API or tool  | x402                                    |
| Agent pays another agent for a sub-task | x402 (immediate) or ERC-8183 (deferred) |

### Where Settlement is N**ot** Brain's job

| Boundary          | Who Handles                                    |
| ----------------- | ---------------------------------------------- |
| Funds in transit  | Tenant's smart account or rail; not Brain      |
| Final settlement  | The settlement layer (Base, an off-chain rail) |
| Tax and reporting | Tenant and tenant's accounting tooling         |

Brain coordinates and proves; it does not hold.
