---
description: Five minutes from npm install to a working read-only integration.
---

# Quickstart

By the end of this page, you'll have a working integration that reads a tenant's
ledger, audit history, and governance state with a commercial API key. Five
minutes.

{% stepper %}
{% step %}

### Install

```bash
npm install @brainfinance/sdk
```

{% endstep %}

{% step %}

### Get a Key

Sign up at [app.robotmoney.com](https://app.robotmoney.com/), create a tenant,
and copy your sandbox API key (`brain_sk_test_...`) and tenant id.

```bash
# .env
BRAIN_API_KEY=brain_sk_test_...
BRAIN_TENANT_ID=tnt_...
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
import { Brain, BrainAPIError } from "@brainfinance/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY!, environment: "sandbox" });
const tenantId = process.env.BRAIN_TENANT_ID!;

// ledger:read
const accounts = await brain.accounts.list({ limit: 10 });
console.log(accounts.accounts);

const transactions = await brain.transactions.list({ limit: 10 });
console.log(transactions.transactions);

// audit:read
const audit = await brain.audit.list({ limit: 10 });
console.log(audit.events);

// governance:read. This route is available through the typed low-level client.
const { data, error, response } = await brain.http.GET("/governance/agents", {
  params: { query: { tenant_id: tenantId, limit: 10 } },
});
if (!response.ok || error || !data) {
  throw new BrainAPIError(response.status, error);
}
console.log(data.agents);
```

That's it. Every call was read-only and used one of the three scopes currently
issuable to a commercial API key: `ledger:read`, `audit:read`, or
`governance:read`.
{% endstep %}

{% step %}

### What You Just Built

| Call                      | Required scope    | What Brain did                           |
| ------------------------- | ----------------- | ---------------------------------------- |
| `brain.accounts.list`     | `ledger:read`     | Read normalized ledger accounts          |
| `brain.transactions.list` | `ledger:read`     | Read normalized ledger transactions      |
| `brain.audit.list`        | `audit:read`      | Read tenant-attributed audit evidence    |
| `GET /governance/agents`  | `governance:read` | Read the tenant's registered agent state |

A `brain_sk_*` key cannot call Wiki, create or decide proposals, approve a
payment, or execute money movement. Those surfaces require a member session or
an exchanged, server-scoped agent credential. Do not widen a commercial key to
make those examples work.

The repository includes an executable version with configuration checks and a
nonzero exit status on failure:

```bash
BRAIN_API_KEY=brain_sk_test_... \
BRAIN_TENANT_ID=tnt_... \
BRAIN_BASE_URL=https://staging-api.brain.fi/v1 \
pnpm -C clients/sdk exec tsx examples/commercial-read-only.ts
```

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
