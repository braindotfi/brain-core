---
description: Five minutes from npm install to a working integration.
---

# Quickstart

By the end of this page, you'll have a working integration that reads a tenant's financial state in natural language, proposes a payment, and pulls a verifiable receipt for what happened. Five minutes.

{% stepper %}
{% step %}

### Install

```bash
npm install @brainfinance/sdk
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
Sandbox uses test credentials and Base Sepolia for on-chain anchoring; no real money moves. The Console lives at `console.brain.fi`; sandbox API requests go to `https://staging-api.brain.fi/v1`, the same host the SDK uses for both `sandbox` and `staging`. Production API requests go to `https://api.brain.fi/v1`. See [API base URLs](../api-reference/overview.md#base-urls).
{% endhint %}

{% hint style="warning" %}
**Production keys (`brain_sk_live_...`) use the identical code path, but Brain is in staging / controlled pilot today.** Settlement rails run on **Base Sepolia** behind smart contracts **pending an external audit**, so a live key does not yet move real money on mainnet. See [Readiness Summary](../architecture/readiness-summary.md) before treating `brain_sk_live_` as production-ready.
{% endhint %}
{% endstep %}

{% step %}

### Build

```typescript
import { Brain, PolicyApprovalRequiredError } from "@brainfinance/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY!, environment: "sandbox" });

// Read sandbox ledger data.
const accounts = await brain.accounts.list({ limit: 10 });
console.log(accounts.accounts);

// Ask the tenant's financial brain a question.
const answer = await brain.ask("acme", "What did we spend on AWS last month?");
console.log(answer.text);
console.log(answer.citations);

// Propose a payment.
let paymentId: string | undefined;
try {
  const result = await brain.pay("acme", {
    action_type: "ach_outbound",
    source_account_id: "acct_demo_ap",
    destination_counterparty_id: "cp_demo_vendor",
    amount: "125.00",
    currency: "USD",
    evidence_ids: ["raw_demo_invoice"],
    idempotencyKey: "quickstart-demo-001",
  });
  paymentId = result.intent.id;
} catch (error) {
  if (!(error instanceof PolicyApprovalRequiredError)) throw error;
  paymentId = error.intent.id;
  if (paymentId) {
    await brain.approve(paymentId);
    await brain.payments.execute(paymentId);
  }
}

// Pull a verifiable receipt.
const proof = await brain.proof(paymentId!);
console.log(proof.anchorTx); // on-chain anchor on Base Sepolia
console.log(proof.merklePath); // verifiable without trusting Brain
```

That's it. You just touched all five capabilities of Brain through one client.
{% endstep %}

{% step %}

### What You Just Built

| Line                     | What Brain did under the hood                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `brain.accounts.list`    | Read normalized ledger accounts through the SDK                                                               |
| `brain.ask`              | Routed your question to a memory graph, retrieved relevant facts with citations, answered in natural language |
| `brain.pay`              | Created a PaymentIntent and evaluated it against the tenant's signed policy                                   |
| `brain.approve`          | Recorded an authenticated member approval when policy required it                                             |
| `brain.payments.execute` | Enqueued the approved intent for the worker-owned execution path                                              |
| `brain.proof`            | Pulled a Merkle proof from a tamper-evident log anchored on Base L2                                           |

You'll meet each of these underneath as you go deeper. For now, they're just five methods on one client.
{% endstep %}
{% endstepper %}

### Where to Go Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Build</strong></td><td>Task-shaped guides. Read a tenant's full financial picture, give an agent a spending limit, audit every action.</td><td><a href="../build/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>Concepts</strong></td><td>The mental model in five minutes.</td><td><a href="../concepts/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>Protocol</strong></td><td>The deep stack: six layers, smart contracts, on-chain anchoring.</td><td><a href="../protocol/overview.md">overview.md</a></td><td></td></tr></tbody></table>

### Stuck?

Error codes are lowercase `snake_case` (see the [full registry](../resources/errors.md)).

| Problem            | Fix                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_invalid_key` | Check `.env`. Sandbox keys start with `brain_sk_test_`, production with `brain_sk_live_`.                                                                            |
| `tenant_not_found` | Create a tenant in the Console first. Tenant IDs are case-sensitive.                                                                                                 |
| `rate_limited`     | You hit your tier's per-minute limit. Honour the `Retry-After` header and retry. See [rate limits](../api-reference/overview.md#rate-limits) for the per-tier table. |

[**Full error reference**](../resources/errors.md)
