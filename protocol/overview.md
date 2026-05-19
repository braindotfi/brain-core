# Overview

You don't need to read this section to build with Brain. It's here for the moments when you do: compliance review, custom policy design, on-chain audit, agent autonomy work, or just because you want to understand what's happening underneath.

### The six-layer stack

```
Raw → Ledger → Wiki → Policy → Agent → Audit
```

Information flows up. Control flows down. Each tenant has its own logical instance of every layer, with hard isolation at the database, key, and policy boundaries.

| Layer         | Owns                                        | Concept page             |
| ------------- | ------------------------------------------- | ------------------------ |
| **1. Raw**    | Source evidence, immutable                  | Raw and Ledger           |
| **2. Ledger** | Machine-readable financial truth            | Raw and Ledger           |
| **3. Wiki**   | Human-readable financial memory             | The Wiki                 |
| **4. Policy** | Deterministic permission and approval logic | Policy and Permissioning |
| **5. Agent**  | Proposal and orchestration                  | Agents                   |
| **6. Audit**  | Immutable proof of what happened and why    | Audit and Proof          |

[**→ Six-layer overview**](the-six-layer-stack.md)

### What's in this section

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>The six-layer stack</strong></td><td>The whole protocol on one page.</td><td><a href="the-six-layer-stack.md">the-six-layer-stack.md</a></td><td></td></tr><tr><td><strong>Raw and Ledger</strong></td><td>How evidence becomes deterministic structure.</td><td><a href="raw-and-ledger.md">raw-and-ledger.md</a></td><td></td></tr><tr><td><strong>The Wiki</strong></td><td>The continuously regenerated memory layer.</td><td><a href="the-wiki.md">the-wiki.md</a></td><td></td></tr><tr><td><strong>Policy and permissioning</strong></td><td>Plain-English rules to deterministic guards.</td><td><a href="policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>Agents</strong></td><td>Internal and external agents in the protocol.</td><td><a href="agents.md">agents.md</a></td><td></td></tr><tr><td><strong>Payment intents</strong></td><td>The Ledger entity that represents a proposed action.</td><td><a href="payment-intents.md">payment-intents.md</a></td><td></td></tr><tr><td><strong>The pre-execution gate</strong></td><td>The 13-step deterministic check before any payment.</td><td><a href="the-pre-execution-gate.md">the-pre-execution-gate.md</a></td><td></td></tr><tr><td><strong>Audit and proof</strong></td><td>Tamper-evident history anchored on Base L2.</td><td><a href="audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr><tr><td><strong>Agent contributions</strong></td><td>How external agents contribute evidence safely.</td><td><a href="agent-contributions.md">agent-contributions.md</a></td><td></td></tr></tbody></table>

### Architecture deep dives

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>System overview</strong></td><td>The architecture top-down.</td><td><a href="../architecture/system-overview.md">system-overview.md</a></td><td></td></tr><tr><td><strong>Data flow</strong></td><td>How a single source-of-truth event ripples up the stack.</td><td><a href="../architecture/data-flow.md">data-flow.md</a></td><td></td></tr><tr><td><strong>Write paths</strong></td><td>The two controlled exceptions to bottom-up flow.</td><td><a href="../architecture/write-paths.md">write-paths.md</a></td><td></td></tr><tr><td><strong>Tenant isolation</strong></td><td>Per-tenant boundaries, end to end.</td><td><a href="../architecture/tenant-isolation.md">tenant-isolation.md</a></td><td></td></tr><tr><td><strong>Security and compliance</strong></td><td>Crypto, keys, sanctions, SOC 2 trajectory.</td><td><a href="../architecture/security-and-compliance.md">security-and-compliance.md</a></td><td></td></tr><tr><td><strong>Risks and mitigations</strong></td><td>Where things can go wrong, and what catches them.</td><td><a href="../architecture/risks-and-mitigations.md">risks-and-mitigations.md</a></td><td></td></tr></tbody></table>

### Where the protocol meets the chain

The on-chain surface is intentionally small. Most logic stays off-chain. Four smart contracts on Base L2 anchor the parts that have to be public and tamper-evident.

| Contract                | Anchors                                                      | Page                  |
| ----------------------- | ------------------------------------------------------------ | --------------------- |
| `BrainAuditAnchor`      | Audit Merkle roots per tenant                                | BrainAuditAnchor      |
| `BrainPolicyRegistry`   | Policy version hashes per tenant                             | BrainPolicyRegistry   |
| `BrainSmartAccount`     | ERC-4337 account validating UserOps against scope and policy | BrainSmartAccount     |
| `BrainMCPAgentRegistry` | Agent identity, capabilities, scope grants                   | BrainMCPAgentRegistry |

### Where to start

| If you want to understand...              | Start here                  |
| ----------------------------------------- | --------------------------- |
| The whole stack                           | Six-Layer Stack             |
| Why memory and policy are separate layers | Raw and Ledger              |
| How decisions stay safe                   | Pre-Execution Gate          |
| Why this is verifiable                    | Audit and Proof             |
| What external agents can and can't do     | Agents, Agent Contributions |
