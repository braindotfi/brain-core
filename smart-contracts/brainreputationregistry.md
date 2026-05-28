# BrainReputationRegistry

An _ERC-8004-style_ on-chain home for **agent reputation** (RFC 0001 §7.7). For each agent it stores a single **reputation pointer**. A `bytes32` Merkle root committing to the agent's off-chain reputation dataset. Versioned by a monotonically increasing `epoch`. The chain holds the pointer **only**: no raw history, no score, no PII.

{% hint style="warning" %}
**UNAUDITED. Base Sepolia testnet only.** A pre-audit reference implementation. **Non-custodial** (no funds, no value path), so an unaudited deploy risks no money. But it is batched into the external audit and stays testnet-only until that clears. Immutable: no admin, no upgrade, no pause.
{% endhint %}

### What it is. And isn't

| It is                                                  | It is **not**                                        |
| ------------------------------------------------------ | ---------------------------------------------------- |
| A per-agent `bytes32` reputation pointer (Merkle root) | A store of raw feedback / scores / history           |
| A **Policy threshold input** (read off-chain)          | A money gate or a §6 pre-execution-gate precondition |
| Attestor-written, monotonic, tamper-evident            | A contract that holds or moves any funds             |

### Data model (hash-only, RFC 0001 §3)

| Field       | Type      | Notes                                                      |
| ----------- | --------- | ---------------------------------------------------------- |
| `scoreRoot` | `bytes32` | Merkle root committing to the off-chain reputation dataset |
| `epoch`     | `uint64`  | Monotonic version; strictly increases on each publish      |
| `updatedAt` | `uint64`  | Unix seconds of the latest publication                     |

The ABI is `bytes32` / `address` / `uint` only. No `string`, no PII (enforced by `scripts/check-no-onchain-pii.mjs`).

### How it's used

```
attestor ──publishReputation(agentId, scoreRoot, epoch)──►  BrainReputationRegistry
                                                                   │
Policy ◄── reputationOf(agentId) ──────────────────────────────────┘
   │  derives a score off-chain from the dataset the root commits to
   ▼
tighten-only adjustment (more approvers / lower cap). NEVER loosens, NEVER a §6 gate
```

- **Attestor**. Brain's reputation oracle (a Safe multi-sig in production) is the only writer, rotatable only by itself. It has **no fund-moving power**: a compromised attestor can at worst publish a bad pointer, which. Via Policy's tighten-only rule. Can only make payments _stricter_, never authorize one.
- **Anti-replay**. Each publish must strictly increase the agent's `epoch`; a stale or equal epoch reverts, so an old pointer can never overwrite a newer one.
- **Policy input only**. Reputation may _raise or lower a policy threshold_ but is never the precondition itself. The §6 gate never sees a reputation value (LLM/reputation judgment never replaces a deterministic gate check).

{% hint style="info" %}
`reputationOf` is a public read, so other Base-ecosystem participants can fetch an agent's reputation pointer. The cross-ecosystem interop surface ERC-8004 envisions (RFC 0001 §7.7). Without exposing Brain's private reputation data.
{% endhint %}

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🪪 BrainMCPAgentRegistry</strong></td><td>Agent identity + scope attestation.</td><td><a href="brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr><tr><td><strong>📋 Policy</strong></td><td>How thresholds (incl. reputation) are evaluated.</td><td><a href="../concepts/policy.md">policy.md</a></td><td></td></tr><tr><td><strong>📦 Escrow and X402</strong></td><td>The settlement contracts.</td><td><a href="escrow-and-x402.md">escrow-and-x402.md</a></td><td></td></tr></tbody></table>
