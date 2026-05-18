# Create Your First Request

Install the SDK, initialize a client, and make a first API call.

### Install the SDK

```bash
npm install @brain/sdk
# or
pnpm add @brain/sdk
# or
yarn add @brain/sdk
```

The SDK ships with TypeScript types and supports Node.js 18+.

### Initialize the Client

```typescript
// brain.ts
import { Brain } from "@brain/sdk";

export const brain = new Brain({
  apiKey:          process.env.BRAIN_KEY,
  environment:     "sandbox",
  defaultTenantId: process.env.BRAIN_TENANT_ID,
});
```

| Field             | Required | Notes                                                        |
| ----------------- | -------- | ------------------------------------------------------------ |
| `apiKey`          | Yes      | Your `brain_sk_...` server key                               |
| `environment`     | No       | Defaults to `production`. Set `sandbox` for Getting Started. |
| `defaultTenantId` | No       | If set, can be omitted from individual calls                 |
| `baseUrl`         | No       | Override for self-hosted or proxy setups                     |

### Make a Read Request

The simplest way to verify your setup works is to fetch your tenant.

```typescript
// index.ts
import { brain } from "./brain";

async function main() {
  const tenant = await brain.tenants.get({
    tenantId: "acme",
  });

  console.log(tenant);
}

main().catch(console.error);
```

```bash
npx tsx index.ts
```

Expected output:

```json
{
  "id": "acme",
  "displayName": "Acme Corporation",
  "region": "us-east-1",
  "createdAt": "2025-09-01T12:00:00Z"
}
```

If you see this, your key, environment, and tenant are wired up correctly.

### Equivalent Curl

If you'd rather hit the API directly:

```bash
curl https://api.brain.dev/v1/tenants/acme \
  -H "Authorization: Bearer $BRAIN_KEY"
```

### Inspect a Trace

Every request gets a unique `traceId`. Find it in the response metadata, or in the **Audit → API Calls** view in the Console.

```typescript
const tenant = await brain.tenants.get({ tenantId: "acme" });

// Trace metadata is on the call's response object
console.log(brain.lastTraceId); // e.g., "trc_8f3a92..."
```

In the Console, paste the trace ID into the search bar to see the full timeline:

```
[ traceId: trc_8f3a92...               ]
   ├─ API call:  GET /v1/tenants/acme
   ├─ Auth:      brain_sk_test_a1b2... (Server key, scopes: tenant:read)
   ├─ Latency:   42ms
   └─ Response:  200 OK
```

### Common Errors

| Code                 | Meaning                                                 | Fix                                                  |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| `AUTH_INVALID_KEY`   | Key is malformed, revoked, or for the wrong environment | Check `.env`, regenerate if needed                   |
| `TENANT_NOT_FOUND`   | The `tenantId` doesn't exist in this environment        | Verify spelling; sandbox and production are separate |
| `SCOPE_INSUFFICIENT` | Key lacks the required scope                            | Re-create the key with the right scopes              |
| `RATE_LIMITED`       | You hit the per-minute limit                            | Wait and retry; sandbox has lower limits             |

All errors include a `traceId` for cross-system correlation. When opening a support ticket, include the trace ID and Brain can resolve the exact request.

### Make a Write Request

Try a write to confirm scope and permissions:

```typescript
// Update a tenant display name
const updated = await brain.tenants.update({
  tenantId:    "acme",
  displayName: "Acme Corp.",
});

console.log(updated.displayName); // "Acme Corp."
```

If your key has `tenant:write`, this succeeds. If not, you'll see `SCOPE_INSUFFICIENT` and you can adjust the key in the Console.

### Use the API directly Without the SDK

The SDK is optional. Brain's REST and JSON-RPC surfaces are well-documented and any HTTP client works.

```typescript
const res = await fetch("https://api.brain.dev/v1/tenants/acme", {
  headers: { Authorization: `Bearer ${process.env.BRAIN_KEY}` },
});
const data = await res.json();
```

For LLM-driven external agents, you'll usually use the MCP Server rather than the SDK.
