# Authentication

Brain authenticates three caller types: humans, internal agents, and external agents. The same API endpoints serve all three. Only the credential differs.

| Caller             | Mode                       | Credential                       |
| ------------------ | -------------------------- | -------------------------------- |
| **Human**          | OAuth/SSO via Auth0        | Bearer access token              |
| **Internal agent** | Brain-issued service token | Bearer service token             |
| **External agent** | SIWX (EIP-4361 over Base)  | `agent_token` from SIWX exchange |

### Human authentication (OAuth/SSO)

Brain integrates with Auth0 for OAuth and SAML SSO. The flow follows the standard authorization-code grant with PKCE.

```
Browser              Brain                 Auth0
   │   GET /v1/auth/login                    │
   │ ─────────────────────► redirect ──────► │
   │                                         │
   │  authorization code from Auth0          │
   │ ◄─────────────────────────────────────  │
   │   POST /v1/auth/oauth/exchange          │
   │ ─────────────►                          │
   │   { access_token, expires_at }          │
   │ ◄─────────────                          │
```

Tokens are sent as bearer tokens.

```http
GET /v1/ledger/transactions
Authorization: Bearer <access_token>
```

### External agent authentication (SIWX)

External agents authenticate using **Sign-In With X**, a generalization of EIP-4361 over Base.

#### Step 1: Construct the SIWX message

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

#### Step 2: Sign with the agent's identity key

The agent signs the message with the key registered in `BrainMCPAgentRegistry`.

#### Step 3: Exchange for an agent token

```http
POST /v1/auth/siwx
Content-Type: application/json

{
  "message": "...",
  "signature": "0x..."
}

→ {
  "agent_token": "...",
  "expires_at": "2025-09-01T13:00:00Z",
  "scopes": ["pay_invoice", "rebalance_treasury"]
}
```

#### Step 4: Use the token

```http
POST /v1/agents/payments-v1/propose
Authorization: Bearer <agent_token>
X-Brain-Scope: <EIP-712 ScopeAttestation>
```

{% hint style="info" %}
Every action-class call must include an `X-Brain-Scope` header carrying the EIP-712 ScopeAttestation signed by the tenant. Reading endpoints (Wiki, Ledger, Audit) only require the agent token.
{% endhint %}

### ScopeAttestation EIP-712 type

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

### Token lifetimes

| Token                  | Default TTL | Refreshable             |
| ---------------------- | ----------- | ----------------------- |
| **OAuth access token** | 1 hour      | Yes, via refresh token  |
| **Service token**      | 90 days     | Rotated by tenant admin |
| **Agent token (SIWX)** | 1 hour      | Yes, by re-signing SIWX |
| **Policy verdict**     | 60 seconds  | No, single-use          |

### Revocation

| Type                     | How to Revoke                                            |
| ------------------------ | -------------------------------------------------------- |
| **API key**              | Console or `DELETE /v1/keys/{id}`                        |
| **Active human session** | `POST /v1/auth/logout`                                   |
| **Agent scope**          | `DELETE /v1/agents/{id}/scopes/{capability}`             |
| **Agent registration**   | `POST /v1/agents/{id}/deactivate` (also called on-chain) |

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🌐 API Overview</strong></td><td>Endpoints, versioning, rate limits.</td><td><a href="overview.md">overview.md</a></td><td></td></tr><tr><td><strong>📜 BrainMCPAgentRegistry</strong></td><td>The on-chain agent registry.</td><td><a href="../smart-contracts/brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>
