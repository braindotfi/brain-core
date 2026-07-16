---
description: >-
  AI that runs finance for you. Brain is the financial intelligence layer for
  businesses, transforming financial activity into memory, intelligence, and
  autonomous execution.
---

# Welcome to Brain

You point Brain at a business's existing financial sources (banks, ERP, invoicing tools, on-chain wallets) and you get back a continuously updated, policy-aware record that humans and autonomous software can both read, reason over, and act on safely.

Brain holds neither funds nor rail access. It sits between an account holder and their financial world as the structured intelligence layer: ingest, normalize, remember, govern, execute, prove.

## How Brain Is Organized

Brain is a layered protocol; information flows up and control flows down.

<table><thead><tr><th width="200">Layer</th><th>Job</th></tr></thead><tbody><tr><td>Raw</td><td>Lossless ingestion from any authorized source</td></tr><tr><td>Ledger</td><td>Deterministic normalization into immutable financial truth</td></tr><tr><td>Wiki</td><td>Continuously updated memory and natural-language Q and A</td></tr><tr><td>Policy</td><td>Plain-English rules compiled to deterministic guards</td></tr><tr><td>Agent</td><td>Internal and external agents proposing actions in scope</td></tr><tr><td>Audit</td><td>Per-tenant Merkle tree anchored on Base L2</td></tr></tbody></table>

Reads are grounded in evidence, writes emit audit events, and any financial action has to pass a deterministic pre-execution gate before it leaves the system. Nothing executes outside that gate.

## What Brain Is Not

Brain is not a bank, a custodian, an accounting tool, an agent marketplace, or a generic assistant. Funds and custody belong to the account holder. Brain reads, reasons, governs, and proves; it does not own the assets it operates on.

## A First Integration

```typescript
import { Brain } from "@brainfinance/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY!, environment: "sandbox" });

// Ask a grounded question about a tenant's money.
const answer = await brain.ask("acme", "What's our cash position right now?");

// Propose a payment. Brain runs policy and the pre-execution gate before any settlement.
const action = await brain.pay("acme", { invoiceId: "inv_8231" });

// Get a verifiable record of what just happened.
const proof = await brain.proof(action.intent.id!);
```

That covers most of what a typical integration touches; no on-chain knowledge is required to use any of it.

> **Staging / controlled pilot.** Autonomous execution and on-chain proof are wired end-to-end, but Brain runs on **Base Sepolia** behind smart contracts **pending an external audit**; a `brain_sk_live_` key uses the same code path yet does not move real money on mainnet today. See the [Readiness Summary](architecture/readiness-summary.md).

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Quickstart</strong></td><td>Five minutes from <code>npm install</code> to a working integration.</td><td><a href="introduction/quickstart.md">quickstart.md</a></td><td></td></tr><tr><td><strong>Build</strong></td><td>Task-shaped guides. The patterns most apps need in their first hour.</td><td><a href="build/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>Concepts</strong></td><td>The mental model. Memory, policy, agents, proof.</td><td><a href="concepts/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>Protocol</strong></td><td>The deep stack. Six layers, smart contracts, on-chain anchoring.</td><td><a href="protocol/overview.md">overview.md</a></td><td></td></tr></tbody></table>

## Who Brain Is For

| You're building                    | You use Brain to                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| A B2B finance product              | Skip the integrations layer. Read normalized financial truth across every source |
| An autonomous agent for a business | Give it grounded memory, scoped permissions, and a provable audit trail          |
| A fintech embedding into an ERP    | Ship policy-gated actions on top of existing customer data, no schema rewrites   |
| A treasury or operations dashboard | Query the tenant's full money picture in natural language or structured calls    |
| An external agent marketplace      | Plug into Brain's MCP surface. Same primitives, same audit semantics             |

## What You Can Build

| In an afternoon               | What it looks like                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| A finance copilot             | Ask natural-language questions about a tenant's money; get answers with citations   |
| A spending agent              | Let an autonomous agent pay invoices under a limit; anything bigger goes to a human |
| An ops dashboard              | Read transactions, balances, obligations, and counterparties from one feed          |
| An external agent integration | Plug into any MCP-compatible runtime; full read and propose surface                 |
| A compliance trail            | Every read, every decision, every action, exportable as a tamper-evident log        |

## What Brain Handles for You

| You don't write                          | Because Brain handles                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| Bank, ERP, and on-chain integrations     | Source ingestion across Plaid, NetSuite, Alchemy, Stripe, and more           |
| A memory layer for your agent            | A continuously updated record per tenant, queryable in natural language      |
| A permissioning DSL                      | Plain-English policies compiled to deterministic rules, signed by the tenant |
| A safe execution path                    | A deterministic gate that checks every payment before it leaves              |
| An audit trail your customers can verify | A Merkle-anchored history on Base L2                                         |

## Integration Surfaces

Brain exposes four surfaces. Pick whichever matches your stack. They share the same data, the same policy, and the same audit log.

| Surface         | Best for                                                  | Reference                                      |
| --------------- | --------------------------------------------------------- | ---------------------------------------------- |
| TypeScript SDK  | Web apps, agent runtimes, internal tools                  | [SDK quickstart](introduction/quickstart.md)   |
| HTTP API        | Any language, server-side integrations, custom workflows  | [API reference](api-reference/overview.md)     |
| MCP server      | Third-party agents over the Model Context Protocol        | [MCP server](mcp-server/overview.md)           |
| Smart contracts | On-chain settlement, programmable accounts, scope attests | [Smart contracts](smart-contracts/overview.md) |

## A First Request

```bash
npm install @brainfinance/sdk
```

```typescript
import { Brain } from "@brainfinance/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY!, environment: "sandbox" });

const accounts = await brain.accounts.list({ limit: 10 });
console.log(accounts.accounts);
```

The full SDK surface (`brain.accounts`, `brain.transactions`, `brain.payments`, `brain.audit`, `brain.policy`, `brain.agents`, `brain.wiki`, and more) is documented in the [API reference](api-reference/overview.md). For raw HTTP access, see [Authentication](api-reference/authentication.md).

## Next Steps

- Build it: [Quickstart](introduction/quickstart.md), then the [task-shaped guides](build/overview.md).
- Understand it: [Concepts](concepts/overview.md), then [Protocol](protocol/overview.md).
- Integrate an external agent: [MCP server](mcp-server/overview.md).
- Verify a payment on-chain: [Smart contracts](smart-contracts/overview.md) and [BrainAuditAnchor](smart-contracts/brainauditanchor.md).
- Review the safety model: [SECURITY.md](SECURITY.md). The §6 gate, layer boundaries, audit verification, and threat model.
