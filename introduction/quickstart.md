---
description: Five minutes from npm install to a working integration.
---

# Quickstart

By the end of this page, you'll have a working read-only integration that lists a tenant's ledger state and checks its latest audit anchor. Five minutes.

{% stepper %}
{% step %}

### Install

```bash
npm install @brainfinance/sdk
```

{% endstep %}

{% step %}

### Get a Key

Sign up at [app.robotmoney.com](https://app.robotmoney.com/), create a tenant, and copy your sandbox API key (`brain_sk_test_...`).

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
import { Brain } from "@brainfinance/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY!, environment: "sandbox" });

// Read sandbox ledger data.
const accounts = await brain.accounts.list({ limit: 10 });
console.log(accounts.accounts);

const transactions = await brain.transactions.list({ limit: 10 });
console.log(transactions.transactions);

const balances = await brain.balances.list();
console.log(balances);

// Check the latest tamper-evident audit anchor.
const anchor = await brain.audit.anchor.latest();
console.log(anchor.anchoringMode);
console.log(anchor.anchorTx);
```

That's it. You used a direct commercial API key only for the read scopes it supports.

{% hint style="info" %}
Direct `brain_sk_*` keys are limited to ledger, audit, and governance reads. Wiki, payment proposals, member approvals, and execution require the appropriate user or exchanged agent access token. Do not use a commercial API key for those privileged flows.
{% endhint %}
{% endstep %}

{% step %}

### What You Just Built

| Line                        | What Brain did under the hood                        |
| --------------------------- | ---------------------------------------------------- |
| `brain.accounts.list`       | Read normalized ledger accounts through the SDK      |
| `brain.transactions.list`   | Read normalized ledger transactions                  |
| `brain.balances.list`       | Read current ledger balances                         |
| `brain.audit.anchor.latest` | Read the latest tamper-evident audit anchor metadata |

You'll meet privileged token exchange and action flows in the authentication and build guides.
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
