# Authentication

Brain authenticates three caller types: humans, internal agents, and external agents. The same API endpoints serve all three. Only the credential differs.

| Caller             | Mode                                                | Credential                            |
| ------------------ | --------------------------------------------------- | ------------------------------------- |
| **Human**          | Self-serve email + password, **or** a linked wallet | Bearer owner JWT                      |
| **Internal agent** | Brain-issued service token (your own backend)       | Bearer service token                  |
| **API partner**    | Tenant API key                                      | Bearer `brain_sk_…` key               |
| **External agent** | SIWX (EIP-4361 over Base) + on-chain scope          | `access_token` from the SIWX exchange |

Every credential is presented the same way: `Authorization: Bearer <token>`. There is one bearer mechanism, not several. The `brain_sk_test_…` / `brain_sk_live_…` value you copy from the Console is a tenant API key. The SDK takes it as `new Brain({ apiKey })`. See [Server API key](#server-api-key-brain_sk_) below.

{% hint style="info" %}
Self-serve signup is gated by the `BRAIN_SELF_SERVE_SIGNUP` flag and is **sandbox-only** (RFC 0002): a new tenant can read and _propose_, but moves no money until the existing promotion + external-audit gates clear. Hosted SSO (Auth0/SAML) is **planned (roadmap)**, not in the MVP.
{% endhint %}

{% hint style="warning" %}
The internal `POST /v1/auth/service-token` mint route is a break-glass sandbox/testnet BFF credential path. It uses a shared secret, is not per-user auth, and must stay disabled for live-money or multi-customer production.
{% endhint %}

### Server API key (`brain_sk_`)

The credential a server-side integration uses is a Brain-issued tenant API key with a `brain_sk_` prefix. It authenticates directly as a bearer credential; there is no token exchange step.

| Property            | Value                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| **Format**          | `brain_sk_test_…` (sandbox) / `brain_sk_live_…` (live)                                  |
| **Issued by**       | The Console, per tenant                                                                 |
| **Presented as**    | `Authorization: Bearer brain_sk_…`, or `new Brain({ apiKey: "brain_sk_…" })` in the SDK |
| **Scopes**          | `ledger:read`, `audit:read`                                                             |
| **Sandbox vs live** | Distinct keys per environment                                                           |
| **Lifetime**        | Until revoked or rotated by a tenant admin                                              |

Rate limits, idempotency, and audit attribution are all keyed off this token.

### Human Authentication (self-serve email + password)

A developer self-provisions a sandbox tenant, verifies their email, then logs in for a short-lived **owner JWT** carrying management/read/approve scopes only. Never `payment_intent:propose` / `payment_intent:execute` / `execution:propose` (money movement is an agent + §6-gate concern, never a human-login capability).

**1. Sign up**. Provisions a sandbox tenant + owner.

```http
POST /v1/signup
Content-Type: application/json

{ "email": "founder@example.com", "password": "a-strong-passphrase-12+" }

→ 201 { "tenant_id": "tnt_…", "user_id": "user_…", "status": "pending",
        "verification_token": "…" }   // returned outside production; emailed in prod
```

In production, the API emails the token through the configured ESP client (`EMAIL_ENDPOINT`, `EMAIL_API_KEY`, optional `EMAIL_FROM`). If `BRAIN_SELF_SERVE_SIGNUP` is enabled in production without ESP credentials, API boot fails before signup routes are served.

**2. Verify the email**. Single-use, short-TTL token, scoped to the tenant.

```http
POST /v1/auth/verify-email
{ "tenant_id": "tnt_…", "token": "<verification_token>" }

→ 200 { "verified": true, "user_id": "user_…", "status": "active" }
```

**3. Log in**. Email + password -> owner JWT.

```http
POST /v1/auth/login
{ "email": "founder@example.com", "password": "a-strong-passphrase-12+" }

→ 200 { "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 900,
        "principal": { "type": "user", "tenantId": "tnt_…",
                       "scopes": ["ledger:read","wiki:read","raw:read","raw:write",
                                  "policy:read","policy:write","audit:read","execution:read",
                                  "payment_intent:approve","surfaces:admin"] } }
```

An unknown email and a wrong password return the **same** `401 auth_invalid_credentials` (no user enumeration); an unverified account returns `403 auth_email_unverified`.

```http
GET /v1/ledger/transactions
Authorization: Bearer <access_token>
```

### Wallet Authentication (SIWX). Agents and humans

External agents. And humans who **link a wallet**. Authenticate with **Sign-In With X** (EIP-4361 over Base). An owner can link a wallet to their tenant:

```http
POST /v1/tenants/{tenant_id}/wallets        (owner JWT)
{ "address": "0x…", "principal_type": "human" }   // or "agent" + principal_id
```

At sign-in, SIWX resolves the wallet: one linked to a **human** mints an **owner JWT** (the same management scopes as email login); an **agent** wallet (registered + active in `BrainMCPAgentRegistry`) mints an **agent token**.

#### Step 1: Construct the SIWX Message

```
brain.fi wants you to sign in with your Ethereum account:
0xAgentAddress

URI: https://api.brain.fi
Version: 1
Chain ID: 8453
Nonce: <server-issued nonce>
Issued At: 2025-09-01T12:00:00Z
Expiration Time: 2025-09-01T12:05:00Z
```

A nonce is obtained from `POST /v1/auth/siwx/challenge` (Redis-held, 5-minute TTL).

#### Step 2: Sign with the Identity Key

The agent (or human's linked wallet) signs the message with the key registered in `BrainMCPAgentRegistry` / linked via `wallet_identities`.

#### Step 3: Exchange for a Token

```http
POST /v1/auth/siwx
Content-Type: application/json

{ "message": "...", "signature": "0x...", "session_id": "..." }

→ {
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "principal": { "type": "agent", "tenantId": "tnt_…", "scopes": ["ledger:read", "payment_intent:propose"] }
}
```

#### Step 4: Use the Token

```http
POST /v1/agents/mcp
Authorization: Bearer <access_token>
```

{% hint style="info" %}
The MCP auth chain additionally verifies the agent record is `active` and that the JWT's `scope_hash` matches the on-chain hash in `BrainMCPAgentRegistry`. Agents can read, contribute evidence, and **propose**. Never **execute** (there is no execute tool; every settlement passes the §6 gate).
{% endhint %}

### ScopeAttestation EIP-712 Type

```
ScopeAttestation(
  bytes32 tenantId,
  address agent,
  bytes32 capability,
  uint128 maxAmount,
  bytes32 resourceScope,
  uint64  notBefore,
  uint64  notAfter,
  uint256 nonce
)
```

### Token Lifetimes

| Token                                             | Default TTL | Refreshable                           |
| ------------------------------------------------- | ----------- | ------------------------------------- |
| **Owner JWT** (email/wallet)                      | 15 minutes  | Yes. Log in / re-sign again           |
| **Agent token (SIWX)**                            | 1 hour      | Yes, by re-signing SIWX               |
| **Server API key** (`brain_sk_`, Console)         | 90 days     | Rotated by tenant admin               |
| **Service-token mint** (`/v1/auth/service-token`) | 1 hour      | Re-mint (break-glass sandbox/testnet) |
| **Email-verification token**                      | 24 hours    | No, single-use                        |
| **Policy verdict**                                | 60 seconds  | No, single-use                        |

Owner JWTs include `surfaces:admin` so a tenant admin can connect or revoke
Slack, Teams, and email approval surfaces. Surface onboarding endpoints derive
the Brain tenant from this bearer principal, not from request bodies.

### Revocation

| Type                   | How to Revoke                                            |
| ---------------------- | -------------------------------------------------------- |
| **Agent scope**        | `DELETE /v1/agents/{id}/scopes/{capability}`             |
| **Agent registration** | `POST /v1/agents/{id}/deactivate` (also called on-chain) |
| **Token**              | Short-lived by design; tokens expire (15 min / 1 hour)   |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🌐 API Overview</strong></td><td>Endpoints, versioning, rate limits.</td><td><a href="overview.md">overview.md</a></td><td></td></tr><tr><td><strong>📜 BrainMCPAgentRegistry</strong></td><td>The on-chain agent registry.</td><td><a href="../smart-contracts/brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>
