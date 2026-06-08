---
description: Five minutes from npm install to a working integration.
---

# Copy of Quickstart

By the end of this page, you'll have a working integration that reads a tenant's financial state in natural language, proposes a payment, and pulls a verifiable receipt for what happened. Five minutes.

{% stepper %}
{% step %}
### Install

```bash
npm install @brain/sdk
```
{% endstep %}

{% step %}
### Get a Key

Sign up at [console.brain.dev](https://console.brain.dev), create a tenant, and copy your sandbox API key (`brain_sk_test_...`).

```bash
# .env
BRAIN_API_KEY=brain_sk_test_...
```

{% hint style="info" %}
Sandbox uses test credentials and Base Sepolia for on-chain anchoring. No real money moves. Production keys (`brain_sk_live_...`) work the same way against `console.brain.fi`.
{% endhint %}
{% endstep %}

{% step %}
### Build

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY });

// Connect a sandbox source (Plaid test data lands in seconds).
await brain.sources.connect("acme", { type: "plaid", credentials: { sandbox: true } });

// Ask the tenant's financial brain a question.
const answer = await brain.ask("acme", "What did we spend on AWS last month?");
console.log(answer.text);
console.log(answer.citations);

// Propose a payment.
const action = await brain.pay("acme", { invoiceId: "inv_8231" });
console.log(action.status); // "auto" | "needs_approval" | "rejected"

// If it needs approval, approve it (in real apps, a human in your UI does this).
if (action.status === "needs_approval") {
  await brain.approve(action.id, { as: "user_cfo" });
}

// Pull a verifiable receipt.
const proof = await brain.proof(action.id);
console.log(proof.txHash); // on-chain anchor on Base
console.log(proof.merklePath); // verifiable without trusting Brain
```

That's it. You just touched all five capabilities of Brain through one client.
{% endstep %}

{% step %}
### What You Just Built

| Line                    | What Brain did under the hood                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `brain.sources.connect` | Ingested 90 days of Plaid sandbox data, built a structured record per transaction, indexed it for retrieval   |
| `brain.ask`             | Routed your question to a memory graph, retrieved relevant facts with citations, answered in natural language |
| `brain.pay`             | Evaluated the action against the tenant's signed policy, returned an immediate decision                       |
| `brain.approve`         | Recorded a typed signature against the policy's required approvers                                            |
| `brain.proof`           | Pulled a Merkle proof from a tamper-evident log anchored on Base L2                                           |

You'll meet each of these underneath as you go deeper. For now, they're just five methods on one client.
{% endstep %}
{% endstepper %}

### Where to Go Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛠 Build</strong></td><td>Task-shaped guides. Read a tenant's full financial picture, give an agent a spending limit, audit every action.</td><td><a href="../build/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>📐 Concepts</strong></td><td>The mental model in five minutes.</td><td><a href="../concepts/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>📦 Protocol</strong></td><td>The deep stack: six layers, smart contracts, on-chain anchoring.</td><td><a href="../protocol/overview.md">overview.md</a></td><td></td></tr></tbody></table>

### Stuck?

| Problem             | Fix                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `AUTH_INVALID_KEY`  | Check `.env`. Sandbox keys start with `brain_sk_test_`, production with `brain_sk_live_`. |
| `TENANT_NOT_FOUND`  | Create a tenant in the Console first. Tenant IDs are case-sensitive.                      |
| `SOURCE_RATE_LIMIT` | Sandbox limits are 60 rpm. Wait and retry.                                                |

[**→ Full error reference**](../resources/errors.md)
