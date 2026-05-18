# System Overview

Brain is a layered protocol where information flows up and control flows down. Each tenant has its own logical instance of every layer, with hard isolation at the database, KMS, and policy boundaries.

### At a glance

```
┌────────────────────────────────────────────────────────────────┐
│                    Clients (humans, agents)                    │
│         Dashboard · Internal services · External MCP           │
└────────────────────────────────────────────────────────────────┘
                              ↓ Auth (OAuth / SIWX)
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
                              │  ERC-4337 UserOps · x402       │
                              └────────────────────────────────┘
```

### What lives where

| Component                     | Location                                 | Notes                                            |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------ |
| **Raw artifacts**             | Azure Blob                               | Content-addressed, encrypted, tenant-scoped DEKs |
| **Ledger records**            | Postgres                                 | Immutable, append-only with supersedence         |
| **Wiki graph and embeddings** | Postgres + pgvector                      | Updated incrementally                            |
| **Policy compiled form**      | Postgres                                 | Hash-anchored on-chain                           |
| **Audit hash chain**          | Postgres                                 | Merkle roots batched on-chain                    |
| **Agent identity**            | `BrainMCPAgentRegistry` (Base L2)        | ERC-8004 compatible                              |
| **Smart account state**       | `BrainSmartAccount` per tenant (Base L2) | ERC-4337                                         |
| **Policy hashes**             | `BrainPolicyRegistry` (Base L2)          | EIP-712 signed by tenant                         |
| **Audit anchors**             | `BrainAuditAnchor` (Base L2)             | EIP-712 signed by Brain anchorer                 |

### On-chain surface is intentionally small

Brain's on-chain surface is intentionally minimal. **Most logic lives off-chain.** On-chain contracts exist for four narrow purposes:

| On-Chain Purpose                                    | Contract                |
| --------------------------------------------------- | ----------------------- |
| **Anchor state**                                    | `BrainAuditAnchor`      |
| **Register policy hashes**                          | `BrainPolicyRegistry`   |
| **Register agent identity**                         | `BrainMCPAgentRegistry` |
| **Enforce ERC-4337 validation and route execution** | `BrainSmartAccount`     |

All contracts are deployed on Base L2 and written in Solidity 0.8.x, built and tested with Foundry. Upgrades use a transparent proxy pattern with a 48-hour timelock.

[**→ Smart contract overview**](../smart-contracts/overview.md)

### Six layers, one API

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
| **Base mainnet**   | Primary execution environment for production tenants |
| **Base Sepolia**   | Sandbox for development                              |
| **External rails** | Bank APIs, processors, custodians (off-chain)        |

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📥 Data Flow</strong></td><td>End-to-end walkthrough of an action.</td><td><a href="data-flow.md">data-flow.md</a></td><td></td></tr><tr><td><strong>🔒 Tenant Isolation</strong></td><td>How tenants are separated at every layer.</td><td><a href="tenant-isolation.md">tenant-isolation.md</a></td><td></td></tr><tr><td><strong>🛡️ Security and Compliance</strong></td><td>Non-negotiable principles.</td><td><a href="security-and-compliance.md">security-and-compliance.md</a></td><td></td></tr></tbody></table>
