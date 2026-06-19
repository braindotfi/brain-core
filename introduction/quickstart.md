---
description: Five minutes from npm install to a working integration.
---

# Quickstart

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

Sign up at [console.brain.fi](https://console.brain.fi), create a tenant, and copy your sandbox API key (`brain_sk_test_...`).

```bash
# .env
BRAIN_API_KEY=brain_sk_test_...
```

{% hint style="info" %}
Sandbox uses test credentials and Base Sepolia for on-chain anchoring; no real money moves. The Console lives at `console.brain.fi`; API requests go to `https://api.sandbox.brain.fi` (sandbox) and `https://api.brain.fi` (production). See [API base URLs](../api-reference/overview.md#base-urls).
{% endhint %}

{% hint style="warning" %}
**Production keys (`brain_sk_live_...`) use the identical code path, but Brain is in staging / controlled pilot today.** Settlement rails run on **Base Sepolia** behind smart contracts **pending an external audit**, so a live key does not yet move real money on mainnet. See [Readiness Summary](../architecture/readiness-summary.md) before treating `brain_sk_live_` as production-ready.
{% endhint %}
{% endstep %}

{% step %}

### Build

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({ token: process.env.BRAIN_API_KEY });

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

Error codes are lowercase `snake_case` (see the [full registry](../resources/errors.md)).

| Problem            | Fix                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_invalid_key` | Check `.env`. Sandbox keys start with `brain_sk_test_`, production with `brain_sk_live_`.                                                                            |
| `tenant_not_found` | Create a tenant in the Console first. Tenant IDs are case-sensitive.                                                                                                 |
| `rate_limited`     | You hit your tier's per-minute limit. Honour the `Retry-After` header and retry. See [rate limits](../api-reference/overview.md#rate-limits) for the per-tier table. |

[**→ Full error reference**](../resources/errors.md)
