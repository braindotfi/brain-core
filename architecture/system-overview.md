# System Overview

Brain is a layered protocol where information flows up and control flows down. Each tenant has its own logical instance of every layer, with hard isolation at the database, KMS, and policy boundaries.

### At a Glance

```
┌────────────────────────────────────────────────────────────────┐
│                    Clients (humans, agents)                    │
│         Dashboard · Internal services · External MCP           │
└────────────────────────────────────────────────────────────────┘
                              ↓ Auth (email/password · SIWX)
┌────────────────────────────────────────────────────────────────┐
│                          Brain API                             │
│              REST · JSON-RPC · MCP server surface              │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│                  The Six-Layer Protocol Stack                  │
│  Raw → Ledger → Wiki → Policy → Agent → Audit                  │
└────────────────────────────────────────────────────────────────┘
                ↓                              ↓
┌─────────────────────────────┐  ┌─────────────────────────────┐
│        Off-chain state      │  │    On-chain commitments     │
│  Postgres · pgvector · Azure Blob   │  │   Base L2 · Brain contracts │
└─────────────────────────────┘  └─────────────────────────────┘
                                              ↓
                              ┌────────────────────────────────┐
                              │ Execution rails                │
                              │  Bank APIs · Processors ·      │
                              │  Session-key smart account     │
                              │  (x402 planned. RFC 0001)     │
                              └────────────────────────────────┘
```

### What Lives Where

| Component                     | Location                                 | Notes                                                                                          |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Raw Artifacts**             | Azure Blob                               | Content-addressed, encrypted, tenant-scoped DEKs                                               |
| **Ledger Records**            | Postgres                                 | Immutable, append-only with supersedence                                                       |
| **Wiki Graph and Embeddings** | Postgres + pgvector                      | Updated incrementally                                                                          |
| **Policy Compiled Form**      | Postgres                                 | Hash-anchored on-chain                                                                         |
| **Audit Hash Chain**          | Postgres                                 | Merkle roots batched on-chain                                                                  |
| **Agent Identity**            | `BrainMCPAgentRegistry` (Base L2)        | Stores `agentId`/`tenantId`/`scopeHash`/`behaviorHash` (ERC-8004 reputation planned. RFC 0001) |
| **Smart Account State**       | `BrainSmartAccount` per tenant (Base L2) | Session-key account (scope, spend caps, bound `policyVersion`)                                 |
| **Policy Hashes**             | `BrainPolicyRegistry` (Base L2)          | EIP-712 signed by tenant                                                                       |
| **Audit Anchors**             | `BrainAuditAnchor` (Base L2)             | EIP-712 signed by Brain anchorer                                                               |

### On-Chain Surface Is Intentionally Small

Brain's on-chain surface is intentionally minimal. **Most logic lives off-chain.** On-chain contracts exist for four narrow purposes:

| On-Chain Purpose                                         | Contract                |
| -------------------------------------------------------- | ----------------------- |
| **Anchor State**                                         | `BrainAuditAnchor`      |
| **Register Policy Hashes**                               | `BrainPolicyRegistry`   |
| **Register Agent Identity**                              | `BrainMCPAgentRegistry` |
| **Enforce Session-Key Scope/Limits and Route Execution** | `BrainSmartAccount`     |

All contracts are deployed on Base L2 and written in Solidity 0.8.x, built and tested with Foundry. The contracts are immutable: there is no upgrade path in the MVP, and any change ships as a separately audited redeploy.

[**→ Smart contract overview**](../smart-contracts/overview.md)

### Six Layers, One API

The same API surface serves humans, internal agents, and external agents. Auth differs; primitives don't.

| Layer      | Primary API Endpoints                                    |
| ---------- | -------------------------------------------------------- |
| **Raw**    | `POST /v1/sources`, `POST /v1/raw/ingest`                |
| **Ledger** | `GET /v1/ledger/transactions`, `GET /v1/ledger/balances` |
| **Wiki**   | `POST /v1/wiki/question`, `GET /v1/wiki/entity/{id}`     |
| **Policy** | `POST /v1/policy`, `POST /v1/policy/evaluate`            |
| **Agent**  | `POST /v1/agents`, `POST /v1/agents/{id}/propose`        |
| **Audit**  | `GET /v1/audit/{id}`, `GET /v1/audit/{id}/proof`         |

[**→ Full API reference**](../api-reference/overview.md)

### Networks

| Network            | Role                                                 |
| ------------------ | ---------------------------------------------------- |
| **Base Mainnet**   | Primary execution environment for production tenants |
| **Base Sepolia**   | Sandbox for development                              |
| **External Rails** | Bank APIs, processors, custodians (off-chain)        |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📥 Data Flow</strong></td><td>End-to-end walkthrough of an action.</td><td><a href="data-flow.md">data-flow.md</a></td><td></td></tr><tr><td><strong>🔒 Tenant Isolation</strong></td><td>How tenants are separated at every layer.</td><td><a href="tenant-isolation.md">tenant-isolation.md</a></td><td></td></tr><tr><td><strong>🛡️ Security and Compliance</strong></td><td>Non-negotiable principles.</td><td><a href="security-and-compliance.md">security-and-compliance.md</a></td><td></td></tr></tbody></table>
