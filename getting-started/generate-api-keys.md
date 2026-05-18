# Generate API Keys

Generate and manage API keys for sandbox and production. Keys are scoped per environment and per role.

### Generate a Key

<table><thead><tr><th width="100">Step</th><th>Action</th></tr></thead><tbody><tr><td>1</td><td>Open <strong>Settings → API Keys</strong> in the Console</td></tr><tr><td>2</td><td>Click <strong>Create Key</strong></td></tr><tr><td>3</td><td>Pick the key type and scope</td></tr><tr><td>4</td><td>Copy the key immediately. It will not be shown again.</td></tr></tbody></table>

{% hint style="warning" %}
Brain only shows the full secret once, at creation time. After that, only a fingerprint (first 8 characters) is displayed. If you lose a key, revoke it and create a new one.
{% endhint %}

### Key Types

| Type           | Prefix         | Use Case                    | Where to Use                        |
| -------------- | -------------- | --------------------------- | ----------------------------------- |
| **Server key** | `brain_sk_...` | Backend integrations        | Server-side only, never client-side |
| **Public key** | `brain_pk_...` | Read-only access            | Safe to ship in browser code        |
| **Anchor key** | `brain_ak_...` | Self-hosted Brain anchorers | Reserved for advanced setups        |

For most integrations, you'll generate one or two **server keys**, kept on your backend.

### Scoping

When you create a key, you can restrict what it can do.

<table><thead><tr><th width="250">Scope</th><th>Allows</th></tr></thead><tbody><tr><td><code>tenant:read</code></td><td>Read Ledger, Wiki, audit data for this tenant</td></tr><tr><td><code>tenant:write</code></td><td>Connect sources, ingest raw artifacts</td></tr><tr><td><code>policy:manage</code></td><td>Create and register policies</td></tr><tr><td><code>agents:manage</code></td><td>Register agents and grant scopes</td></tr><tr><td><code>actions:propose</code></td><td>Propose actions through agents</td></tr><tr><td><code>actions:approve</code></td><td>Approve escalated actions</td></tr><tr><td><code>actions:execute</code></td><td>Execute approved actions</td></tr></tbody></table>

A least-privilege server key for a CI pipeline might have only `tenant:read`. A backend serving an end-user dashboard might also have `actions:propose` and `actions:execute`.

### Store Keys Safely

```bash
# .env (never commit this file)
BRAIN_KEY=brain_sk_test_a1b2c3...
BRAIN_TENANT_ID=acme
BRAIN_ENV=sandbox
```

```typescript
// Load from environment
import { Brain } from "@brain/sdk";

const brain = new Brain({
  apiKey:          process.env.BRAIN_KEY,
  environment:     process.env.BRAIN_ENV as "sandbox" | "production",
  defaultTenantId: process.env.BRAIN_TENANT_ID,
});
```

{% hint style="warning" %}
Never commit API keys to source control. Add `.env` to your `.gitignore`. In production, use a secrets manager (AWS Secrets Manager, Google Secret Manager, HashiCorp Vault, Doppler, or 1Password Connect).
{% endhint %}

### Rotation

Keys should be rotated regularly. The Console supports zero-downtime rotation.

<table><thead><tr><th width="100">Step</th><th>Action</th></tr></thead><tbody><tr><td>1</td><td>Create a new key with the same scopes</td></tr><tr><td>2</td><td>Deploy the new key to your service</td></tr><tr><td>3</td><td>Verify traffic is flowing on the new key (check the Console's <strong>Activity</strong> tab)</td></tr><tr><td>4</td><td>Revoke the old key</td></tr></tbody></table>

### Revocation

```
Settings → API Keys → [select key] → Revoke
```

Revocation is immediate. Any in-flight requests using the revoked key fail with `AUTH_INVALID_KEY`.

### Audit

Every API call logs the key fingerprint that authenticated it. Open **Audit → API Calls** in the Console to see which key made which call. This is useful for incident response: if a key is compromised, you can identify exactly which actions it took before being revoked.

### Webhook Secrets

If you subscribe to webhooks, Brain signs each payload with HMAC-SHA256 using your webhook secret. Generate this secret separately under **Settings → Webhooks**. Verify the `X-Brain-Signature` header before processing webhook payloads.

```typescript
import { createHmac, timingSafeEqual } from "crypto";

function verifyWebhook(rawBody: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```
