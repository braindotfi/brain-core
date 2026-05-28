# Escrow and X402

For agent-to-agent (M2M) commerce where a payment must be **conditioned on job completion**, Brain provides `BrainEscrow`. A custodial USDC escrow on Base. For per-call API access, Brain integrates **x402**. Both terminate in the same `PaymentIntent → §6 gate → audit` flow; neither is a second money path.

{% hint style="warning" %}
**`BrainEscrow` is UNAUDITED and Base Sepolia testnet only.** It is a pre-audit reference implementation (RFC 0001 §7.6). Immutable (no admin, no upgrade, no pause), and it must clear an external security audit before any mainnet address is funded.
{% endhint %}

| Mechanism       | Use case                                                                |
| --------------- | ----------------------------------------------------------------------- |
| **BrainEscrow** | Job-style work where USDC releases incrementally as milestones complete |
| **x402**        | Per-call API access where payment settles inline with each HTTP request |

### BrainEscrow. Custodial, hash-only, incremental

A payer locks USDC **into the contract** against a `jobTermsHash` (a keccak256 commitment of the off-chain terms. No PII, RFC 0001 §3). Funds then **release** to the payee or **refund** to the payer. Settlement is **incremental**: `release(amount)` and `refund(amount)` each move a partial sum, supporting **milestone payments** and **arbiter dispute-splits**. The escrow stays `Locked` until `released + refunded` reaches the full amount, then becomes `Settled`.

```
lock(escrowId, payee, USDC, amount, jobTermsHash, deadline)   ← payer deposits USDC
        │
        ▼   release(amount)  (payer confirms delivery, or arbiter attests)
   Locked ───────────────────────────────────────────────►  pays the payee
        │   refund(amount)   (arbiter any time, or payer after deadline)
        └───────────────────────────────────────────────►  returns to the payer
        │
        ▼  when released + refunded == amount
     Settled (terminal)
```

| Action      | Who                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| **lock**    | The payer (buyer/agent). Deposits USDC against the job commitment                                                         |
| **release** | The payer (confirming delivery, incl. per-milestone) **or** the arbiter (attesting / resolving a dispute). Pays the payee |
| **refund**  | The **arbiter** any time (dispute), **or** the payer once the `deadline` passes (job not delivered). Returns to the payer |

{% hint style="info" %}
**The contract custodies the USDC; Brain (the operator) cannot redirect it.** The `arbiter` is immutable (a Safe multi-sig in production) and can only ever **release to the designated payee** or **refund to the designated payer**. Never to an arbitrary address. There is no admin/drain path. A dispute is resolved by a partial release to the payee plus a partial refund to the payer on the same lock.
{% endhint %}

### Gate binding (§6 check 6.6)

Before a release is gated through, the §6 pre-execution gate reads `getEscrow(escrowId)` and binds the PaymentIntent to the on-chain lock: still `Locked`, enough **remaining** balance (`amount − released − refunded`) to cover this release, same payee, same `jobTermsHash`. Binding against `remaining` (not the full `amount`) is what lets each milestone after the first through.

### X402 Machine-Native Payments

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

### When to Use Which

| Scenario                                | Mechanism                                  |
| --------------------------------------- | ------------------------------------------ |
| Agent paid on completion of a job       | BrainEscrow                                |
| Agent pays per-call for an API or tool  | x402                                       |
| Agent pays another agent for a sub-task | x402 (immediate) or BrainEscrow (deferred) |

### Where Settlement Is **Not** Brain's Job

| Boundary                          | Who Handles                                    |
| --------------------------------- | ---------------------------------------------- |
| Immediate (x402) funds in transit | The tenant's smart account / rail; not Brain   |
| Final settlement                  | The settlement layer (Base, an off-chain rail) |
| Tax and reporting                 | Tenant and tenant's accounting tooling         |

Brain (the operator) never holds or redirects funds. For _conditional_ settlement the immutable `BrainEscrow` contract escrows USDC. But it can only ever release to the designated payee or refund the designated payer; there is no path for Brain to redirect it.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>The smart account that locks and releases.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr><tr><td><strong>🏅 BrainReputationRegistry</strong></td><td>How agent reputation is referenced on-chain.</td><td><a href="brainreputationregistry.md">brainreputationregistry.md</a></td><td></td></tr><tr><td><strong>🤖 Agents</strong></td><td>The conceptual model.</td><td><a href="../concepts/agents.md">agents.md</a></td><td></td></tr></tbody></table>
