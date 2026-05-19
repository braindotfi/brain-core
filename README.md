---
description: A financial brain in a single API. Reads money, governs action, proves what happened.
---

# Welcome to Brain 🧠

**Brain is a financial brain in a single API.** It turns financial
activity into memory, memory into intelligence, and intelligence into
governed execution — with a verifiable audit trail of everything it
did.

You point Brain at a business's existing financial sources — banks,
ERP, invoicing tools, on-chain wallets — and you get back a continuously
updated, policy-aware record that humans and AI agents can both read,
reason over, and act on safely.

## The simple version

Today, every fintech app rebuilds the same plumbing from scratch:
ingest from banks and ERPs, normalize transactions, build a memory
model, write permission rules, gate execution, log everything.

Brain is that plumbing as a protocol. A single API gives you the
financial picture, the policy guardrails, the execution path, and the
audit trail — in one place, with one integration.

## The technical version

Brain is a layered protocol. Information flows up; control flows down.

**Raw → Ledger → Wiki → Policy → Agent → Audit**

| Layer      | Job                                                         |
| ---------- | ----------------------------------------------------------- |
| **Raw**    | Lossless ingestion from any authorized source               |
| **Ledger** | Deterministic normalization into immutable financial truth  |
| **Wiki**   | Continuously updated memory + natural-language Q&A          |
| **Policy** | Plain-English rules compiled to deterministic guards        |
| **Agent**  | Internal and third-party agents proposing actions in scope  |
| **Audit**  | Per-tenant Merkle tree anchored on Base L2                  |

Every read is grounded in evidence. Every write emits an audit event.
Every action passes a deterministic pre-execution gate. Nothing
executes outside that gate.

## What Brain is not

**❌ A bank.** Brain holds neither funds nor rail access. The customer keeps both.

**❌ A custodian.** Cryptographic keys for a tenant's smart account belong to the tenant. Brain co-signs against policy; it does not own custody.

**❌ An accounting tool.** Brain produces reports, but it also enforces policy and dispatches actions, with audit, on the tenant's behalf.

**❌ An agent marketplace.** Marketplaces sell agents. Brain is what those agents read from, write to, and prove against.

**❌ An AI assistant.** Generic assistants reason but cannot trust their inputs or prove their outputs. Brain reasons over a verified ledger and emits a tamper-evident audit trail.

## What Brain is

**Brain is a financial brain in one API.** Give an AI agent memory of
a business's money, the rules to act on it safely, and a verifiable
trail of everything it did.

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY });

// What's our cash position?
const answer = await brain.ask("acme", "What's our cash position right now?");

// Pay this invoice if policy allows it; otherwise queue for approval.
const action = await brain.pay("acme", { invoiceId: "inv_8231" });

// Prove what just happened.
const proof = await brain.proof(action.id);
```

Three calls. One API key. No on-chain knowledge required. Brain
handles the rest.

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🚀 Quickstart</strong></td><td>Five minutes from <code>npm install</code> to a working integration.</td><td><a href="introduction/quickstart.md">quickstart.md</a></td><td></td></tr><tr><td><strong>🛠 Build</strong></td><td>Task-shaped guides. The patterns most apps need in their first hour.</td><td><a href="build/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>📐 Concepts</strong></td><td>The mental model. Memory, policy, agents, proof.</td><td><a href="concepts/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>📦 Protocol</strong></td><td>The deep stack. Six layers, smart contracts, on-chain anchoring.</td><td><a href="protocol/overview.md">overview.md</a></td><td></td></tr></tbody></table>

## Who Brain is for

| You're building…                       | You use Brain to…                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| **A B2B finance product**              | Skip the integrations layer. Read normalized financial truth across every source |
| **An AI agent for a business**         | Give it grounded memory, scoped permissions, and a provable audit trail          |
| **A fintech embedding into an ERP**    | Ship policy-gated actions on top of existing customer data, no schema rewrites   |
| **A treasury or operations dashboard** | Query the tenant's full money picture in natural language or structured calls    |
| **An external agent marketplace**      | Plug into Brain's MCP surface — same primitives, same audit semantics            |

## What you can build

| In an afternoon                   | What it looks like                                                                |
| --------------------------------- | --------------------------------------------------------------------------------- |
| **A finance copilot**             | Ask natural-language questions about a tenant's money; get answers with citations |
| **A spending agent**              | Let an AI agent pay invoices under a limit, with anything bigger going to a human |
| **An ops dashboard**              | Read transactions, balances, obligations, and counterparties from one feed        |
| **An external agent integration** | Plug into any MCP-compatible runtime; full read and propose surface               |
| **A compliance trail**            | Every read, every decision, every action, exportable as a tamper-evident log      |

## Why Brain

Most fintech infrastructure was built for software written by humans.
Brain is built for software written by agents.

| You don't write                          | Because Brain handles                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| Bank, ERP, and on-chain integrations     | Source ingestion across Plaid, NetSuite, Alchemy, Stripe, and more           |
| A memory layer for your agent            | A continuously updated record per tenant, queryable in natural language      |
| A permissioning DSL                      | Plain-English policies compiled to deterministic rules, signed by the tenant |
| A safe execution path                    | A deterministic gate that checks every payment before it leaves              |
| An audit trail your customers can verify | A Merkle-anchored history on Base L2                                         |

## Integration surfaces

Brain exposes three surfaces. Pick whichever matches your stack — they
share the same data, the same policy, the same audit log.

| Surface             | Best for                                                  | Reference                                                                        |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **TypeScript SDK**  | Web apps, agent runtimes, internal tools                  | [SDK Quickstart](introduction/quickstart.md)                                     |
| **HTTP API**        | Any language, server-side integrations, custom workflows  | [API Reference](api-reference/overview.md)                                       |
| **MCP server**      | Third-party AI agents (Claude, OpenAI, custom MCP hosts)  | [MCP Server](mcp-server/overview.md)                                             |
| **Smart contracts** | On-chain settlement, programmable accounts, scope attests | [Smart Contracts](smart-contracts/overview.md)                                   |

## A first request

```bash
npm install @brain/sdk
```

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY });

const tenant = await brain.tenants.get("acme");
console.log(tenant.displayName);
```

The full SDK surface (`brain.accounts`, `brain.transactions`,
`brain.payments`, `brain.audit`, `brain.policy`, `brain.agents`,
`brain.wiki`, and more) is documented in the [API
Reference](api-reference/overview.md). For raw HTTP access, see
[`Authentication`](api-reference/authentication.md).

## Next steps

- **Build it.** [Quickstart](introduction/quickstart.md) →
  [Task-shaped guides](build/overview.md).
- **Understand it.** [Concepts](concepts/overview.md) →
  [Protocol](protocol/overview.md).
- **Integrate an external agent.** [MCP
  Server](mcp-server/overview.md).
- **Verify a payment on-chain.** [Smart
  Contracts](smart-contracts/overview.md) →
  [`BrainAuditAnchor`](smart-contracts/brainauditanchor.md).
