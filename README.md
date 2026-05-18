---
description: A financial brain in a single API.
---

# Welcome to Brain 🧠

**Brain is a financial brain in a single API.** It turns financial activity into memory, memory into intelligence, and intelligence into execution.

#### The simple version <a href="#the-simple-version" id="the-simple-version"></a>

Businesses generate financial activity across different bank accounts, invoices, wallets, ERP, payroll, and payment processors. Today, every fintech app has to reconnect that data, money movement, and decision logic from scratch.

Brain is the missing financial intelligence layer. It reads financial activity from connected sources, turns activity into a verified ledger and memory, checks actions against tenant-created policies, executes through existing rails, and creates a verifiable audit trail on-chain.

#### The technical version <a href="#the-technical-version" id="the-technical-version"></a>

Brain is a layered protocol. Information flows up; control flows down.

Raw → Ledger → Wiki → Policy → Agent → Audit

| Layer      | Job                                                     |
| ---------- | ------------------------------------------------------- |
| **Raw**    | Lossless ingestion from any authorized source           |
| **Ledger** | Deterministic structuring into immutable records        |
| **Wiki**   | Continuously updated memory graph per tenant            |
| **Policy** | Plain-English rules compiled to deterministic guards    |
| **Agent**  | Internal and third-party agents executing within policy |
| **Audit**  | Per-tenant Merkle tree anchored on Base L2              |

#### What Brain is not <a href="#what-brain-is-not" id="what-brain-is-not"></a>

**❌ A bank:** Brain holds neither funds nor rail access. The tenant keeps both.

**❌ A custodian:** Cryptographic keys for a tenant's smart account belong to the tenant. Brain co-signs against policy; it does not own custody.

**❌ An accounting tool:** Brain produces reports, but it also enforces policy and executes actions, with audit, on the tenant's behalf.

**❌ An agent marketplace:** Agent marketplaces sell agents. Brain is what those agents read from, write to, and prove against.

**❌ An AI assistant:** Generic assistants reason but cannot trust their inputs or prove their outputs. Brain reasons over a verified ledger and emits a tamper-evident audit trail.

#### What Brain is <a href="#what-brain-is" id="what-brain-is"></a>

**Brain is a financial brain in one API.** Give an AI agent memory of a user's money, the rules to act on it safely, and a verifiable trail of everything it did.

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY });

// What's our cash position?
const answer = await brain.ask("acme", "What's our cash position right now?");

// Pay this invoice if it's under our limit; otherwise queue for approval.
const action = await brain.pay("acme", { invoiceId: "inv_8231" });

// Prove what just happened.
const proof = await brain.proof(action.id);
```

Three calls. One API key. No on-chain knowledge required. Brain handles the rest.

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🚀 Quickstart</strong></td><td>Five minutes from <code>npm install</code> to a working integration.</td><td><a href="introduction/quickstart.md">quickstart.md</a></td><td></td></tr><tr><td><strong>🛠 Build</strong></td><td>Task-shaped guides. The patterns most apps need in their first hour.</td><td><a href="/broken/pages/sMrrX25ZQX2RkFLnKr3L">Broken link</a></td><td></td></tr><tr><td><strong>📐 Concepts</strong></td><td>The mental model. Memory, policy, execution, proof.</td><td><a href="/broken/pages/xLV8vzuuJnAyV80xBwME">Broken link</a></td><td></td></tr><tr><td><strong>📦 Protocol</strong></td><td>The deep stack. Six layers, smart contracts, on-chain anchoring.</td><td><a href="/broken/pages/DGQRMedmp626EiwDlcTi">Broken link</a></td><td></td></tr></tbody></table>

### What you can build

| In an afternoon                   | What it looks like                                                                |
| --------------------------------- | --------------------------------------------------------------------------------- |
| **A finance copilot**             | Ask natural-language questions about a tenant's money; get answers with citations |
| **A spending agent**              | Let an AI agent pay invoices under a limit, with anything bigger going to a human |
| **An ops dashboard**              | Read transactions, balances, obligations, and counterparties from one feed        |
| **An external agent integration** | Plug into any MCP-compatible runtime; full read and propose surface               |
| **A compliance trail**            | Every read, every decision, every action, exportable as a tamper-evident log      |

### Why Brain

Most fintech infrastructure was built for software written by humans. Brain is built for software written by agents.

| You don't write                          | Because Brain handles                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| Bank, ERP, and on-chain integrations     | Source ingestion across Plaid, NetSuite, Alchemy, Stripe, and more           |
| A memory layer for your agent            | A continuously updated record per tenant, queryable in natural language      |
| A permissioning DSL                      | Plain-English policies compiled to deterministic rules, signed by the tenant |
| A safe execution path                    | A deterministic gate that checks every payment before it leaves              |
| An audit trail your customers can verify | A Merkle-anchored history on Base L2                                         |

### A first request

```bash
npm install @brain/sdk
```

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY });

const tenant = await brain.tenants.get("acme");
console.log(tenant.displayName);
```

### What's in these docs

| Section                                        | For                     |
| ---------------------------------------------- | ----------------------- |
| [Quickstart](introduction/quickstart.md)       | Your first integration  |
| [Build](build/overview.md)                     | Common patterns         |
| [Concepts](concepts/overview.md)               | The mental model        |
| [Protocol](protocol/overview.md)               | How it works underneath |
| [API Reference](api-reference/overview.md)     | Every endpoint          |
| [MCP Server](mcp-server/overview.md)           | For external AI agents  |
| [Smart Contracts](smart-contracts/overview.md) | The on-chain surface    |
| [Resources](resources/errors.md)               | Errors, status, support |
