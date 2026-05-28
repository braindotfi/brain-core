# Onboarding API

Self-serve tenant signup, email verification, owner login, and wallet linking — the RFC 0002 surface. All of these routes are **public** (no bearer token) and gated behind the `BRAIN_SELF_SERVE_SIGNUP` environment flag. With the flag off (the default), `/signup` and `/auth/verify-email` return `404`. Sandbox-first by design.

| Operation              | Endpoint                               | Auth                       |
| ---------------------- | -------------------------------------- | -------------------------- |
| Sign up a new tenant   | `POST /v1/signup`                      | Public (rate-limited)      |
| Verify the owner email | `POST /v1/auth/verify-email`           | Public (rate-limited)      |
| Password login         | `POST /v1/auth/login`                  | Public (rate-limited)      |
| Link a wallet          | `POST /v1/tenants/{tenant_id}/wallets` | Owner JWT + `policy:write` |

For the conceptual walkthrough, see [Sign Up and Onboard](../build/sign-up-and-onboard.md). For the underlying error codes, see the [self-serve onboarding section](../resources/errors.md#self-serve-onboarding) of the errors reference.

### Sign Up

Provisions a new tenant + owner user and either emails a verification token (production) or returns it directly (sandbox / non-production).

```http
POST /v1/signup
Content-Type: application/json

{
  "email":    "owner@acme.com",
  "password": "a-strong-passphrase"
}
```

`password` is 12–4096 bytes and is stored as a scrypt hash (`shared/src/auth/password.ts`). The route returns `201 Created`:

```json
{
  "tenant_id": "tnt_01J0000000000000000000000A",
  "user_id": "usr_01J0000000000000000000000B",
  "status": "pending",
  "verification_token": "vtok_...",
  "verification_sent": false
}
```

`verification_token` is included **only outside production** (no email provider is wired yet); in production it is emailed and `verification_sent: true`. Errors: `400` (validation), `409` (`signup_email_taken`), `429`.

### Verify Email

```http
POST /v1/auth/verify-email
Content-Type: application/json

{
  "tenant_id": "tnt_01J0000000000000000000000A",
  "token":     "vtok_..."
}
```

```json
{
  "verified": true,
  "user_id": "usr_01J0000000000000000000000B",
  "status": "active"
}
```

Errors: `400` (`signup_token_invalid` — invalid, expired, or already used), `429`.

### Password Login

Issues a 15-minute owner JWT. The same `401` is returned for an unknown email and a wrong password (no user enumeration); `403` if the owner email is unverified.

```http
POST /v1/auth/login
Content-Type: application/json

{
  "email":    "owner@acme.com",
  "password": "a-strong-passphrase"
}
```

```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "Bearer",
  "expires_in": 900,
  "principal": {
    "id": "usr_01J0000000000000000000000B",
    "type": "user",
    "tenantId": "tnt_01J0000000000000000000000A",
    "scopes": [
      "ledger:read",
      "wiki:read",
      "policy:read",
      "policy:write",
      "audit:read",
      "execution:read",
      "payment_intent:approve"
    ]
  }
}
```

{% hint style="warning" %}
The owner JWT **never** carries `payment_intent:propose`, `payment_intent:execute`, or `execution:propose`. The owner can read, approve, and manage policy — proposing or executing payments is reserved for registered agents running through the §6 gate.
{% endhint %}

Errors: `401` (`auth_invalid_credentials`), `403` (`auth_email_unverified`), `429`.

### Link a Wallet

Once the owner is logged in (password JWT), they can link a wallet to the tenant. After linking, the same wallet can sign in over SIWX and receive an owner JWT — the "two linked principals" model (email/password for humans + wallet/SIWX for the agent runtime).

```http
POST /v1/tenants/{tenant_id}/wallets
Authorization: Bearer <owner JWT>
Content-Type: application/json

{
  "address":   "0xabc...",
  "signature": "0x..."
}
```

`tenant_id` in the path must equal the JWT's `tenantId`. Returns `201` with the linked wallet record. Errors: `400`, `401`, `403` (tenant mismatch), `409` (`wallet_already_linked`).

### What Comes Next

After login, the tenant typically:

1. Composes and signs a policy via [`POST /v1/policy/{tenant_id}/compose`](policy-api.md) → [`/sign`](policy-api.md).
2. Connects a financial source (Plaid, ERP, wallet) out-of-band and starts ingesting evidence into the [Raw layer](sources-api.md).
3. Registers any external agents via [`POST /v1/execution/agents/register`](agents-api.md).
4. Watches activity via the [Audit API](audit-api.md) and [Proof API](proof-api.md).

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🪪 Authentication</strong></td><td>The fuller auth model (JWT, scopes, SIWX).</td><td><a href="authentication.md">authentication.md</a></td><td></td></tr><tr><td><strong>🚀 Sign Up and Onboard</strong></td><td>The narrative quickstart.</td><td><a href="../build/sign-up-and-onboard.md">sign-up-and-onboard.md</a></td><td></td></tr></tbody></table>
