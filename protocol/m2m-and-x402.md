# M2M Commerce and x402

Machine-to-machine (M2M) commerce is the part of Brain where one agent pays another agent. Directly, on-chain, under the same policy, gate, and audit constraints as any other Brain payment. RFC 0001.

{% hint style="warning" %}
M2M settlement is **shadow-first**. The two new rails (`x402_base` and `escrow_base`) are **unregistered at boot and fail closed** until promoted; the underlying smart contracts (`BrainEscrow`, `BrainReputationRegistry`) are **unaudited testnet** reference implementations. No money moves through them until they're audit-batched and the rails are explicitly promoted in a tenant's configuration.
{% endhint %}

### What M2M Adds. Nothing About the Gate Changes

Brain didn't grow a parallel money path for agents. It grew **two new `action_type`s** that flow through the _same_ `PaymentIntent → Policy → §6 gate → Audit` pipeline as everything else:

| `action_type`    | Rail          | Settlement                                                                         |
| ---------------- | ------------- | ---------------------------------------------------------------------------------- |
| `x402_settle`    | `x402_base`   | USDC on Base via the [x402](https://www.x402.org/) HTTP-native settlement standard |
| `escrow_release` | `escrow_base` | Release (full / partial / dispute-split) of a `BrainEscrow` lock                   |

The §6 pre-execution gate still runs. The audit chain still anchors. Policy still decides. M2M is **not** an opt-out of any of that.

### Two Settlement Patterns

| Pattern         | When                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| **x402**        | Atomic, single-shot machine settlement. "I've finished the work, pay me now in USDC."   |
| **BrainEscrow** | Multi-step engagements. Fund up-front, release on milestones, dispute splits if needed. |

x402 is the right primitive when the payee is verifiable in real time (a service responds, you settle). Escrow is right when the work is bounded in advance and there's a possibility of dispute or staged release.

### Agent Counterparties

The payee in an M2M payment is _another agent_, not a vendor. Brain models this as an **agent counterparty**. A counterparty whose `type` is `agent` (or `wallet` with an attestation linking it to a registered agent in [`BrainMCPAgentRegistry`](../smart-contracts/brainmcpagentregistry.md)). The §6 gate's check 5.5 verifies that an agent payee is registered + active before any M2M settlement runs.

### The 5 M2M §6 Checks

Five gate checks were added at non-canonical positions specifically for M2M. They are active when the `PaymentIntent` carries the relevant settlement or escrow context and the needed loader is configured. For non-settlement payments, they record `not_applicable` or do not add a row as defined by the shared gate. The full gate is the canonical 13 numbered checks plus 10 hardening additions.

| Check                                    | What It Enforces                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **On-chain-settlement permitted** (3.5)  | The payment class is allowed to settle on-chain for this tenant (else it must route off-chain)                                                              |
| **Agent-counterparty attested** (5.5)    | When the payee is an agent, it is registered + active in `BrainMCPAgentRegistry`                                                                            |
| **x402 payment-context valid** (6.5)     | The x402 `paymentRequirements` (amount, asset = USDC, network = Base, recipient) match the intent                                                           |
| **Escrow-state bound** (6.6)             | For an escrow release, the on-chain `BrainEscrow` lock matches: still `Locked`, enough **remaining** to cover this release, same payee, same `jobTermsHash` |
| **Micropayment cap within window** (8.5) | Per-agent rolling-window spend stays within the policy envelope (mirrors the on-chain session-key window cap)                                               |

See [The Pre-Execution Gate](the-pre-execution-gate.md) for the full 23-entry gate trace.

### Reputation as a Tightener, Never a Gate

Agent reputation lives in a separate, ERC-8004-style contract. [`BrainReputationRegistry`](../smart-contracts/brainreputationregistry.md) (RFC 0001, **UNAUDITED testnet**). Policy can read the per-agent reputation pointer and use it as a **tighten-only threshold input**. For example, "only auto-approve M2M settlements under $X to agents above reputation Y."

**Reputation is never a money gate and never a §6 precondition.** A high score doesn't unlock anything beyond what Policy already allows; a low score can only tighten an existing rule. This is the same principle that keeps LLM judgment out of the §6 gate: signal that can move is allowed in; signal that can fail closed in dangerous ways is kept out.

### What Ships Today vs Later

| Capability                                                               | Status                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `x402_settle` / `escrow_release` action types on `POST /payment-intents` | Live in the spec; rails fail closed until promoted                               |
| The 5 M2M §6 gate checks (3.5, 5.5, 6.5, 6.6, 8.5)                       | Live but **dormant**. Each becomes active only when its on-chain loader is wired |
| `BrainEscrow` (custodial; partial release; dispute splits)               | **UNAUDITED reference implementation** on testnet                                |
| `BrainReputationRegistry` (ERC-8004-style pointer; RFC 0001)             | **UNAUDITED testnet**                                                            |
| Agent-counterparty schema, on-chain settlement reconciliation matcher    | Live                                                                             |
| Mainnet promotion of the new contracts                                   | **Requires external audit first**. Non-negotiable                                |

### Why M2M Belongs Inside the Same Gate

The temptation in M2M settlement is to skip the gate "because it's machine-to-machine and fast." Brain rejects that: the gate is the **only** path to financial execution. An agent paying another agent is no different from a treasury system paying a vendor. The same evidence requirements, the same balance check, the same audit-event chain. The §6 design extends; it never shortcuts.

This is what makes M2M commerce on Brain _auditable_ in the same shape as everything else: every settlement produces a [Proof](../api-reference/proof-api.md) you can hand to a counterparty, an auditor, or a regulator.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Payment Intents</strong></td><td>The Ledger entity x402_settle and escrow_release flow through.</td><td><a href="payment-intents.md">payment-intents.md</a></td><td></td></tr><tr><td><strong>The Pre-Execution Gate</strong></td><td>The 23-entry gate trace, including the M2M checks.</td><td><a href="the-pre-execution-gate.md">the-pre-execution-gate.md</a></td><td></td></tr><tr><td><strong>Escrow and x402</strong></td><td>The on-chain contracts.</td><td><a href="../smart-contracts/escrow-and-x402.md">escrow-and-x402.md</a></td><td></td></tr><tr><td><strong>BrainReputationRegistry</strong></td><td>The reputation pointer contract.</td><td><a href="../smart-contracts/brainreputationregistry.md">brainreputationregistry.md</a></td><td></td></tr></tbody></table>
