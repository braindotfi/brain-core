---
description: Go from zero to an authenticated sandbox tenant. Human login or a wallet-based agent.
---

# Sign Up and Onboard

Self-serve onboarding provisions a **sandbox tenant** you can read and _propose_ against immediately. Real money stays behind the promotion + external-audit gates, so onboarding is safe to explore end-to-end.

{% hint style="info" %}
Self-serve signup is gated by the `BRAIN_SELF_SERVE_SIGNUP` flag and lands every new tenant in **sandbox** (RFC 0002). Two principals share one tenant: a **human owner** (email/password or a linked wallet) for management + reads + approvals, and **agents** (wallet + on-chain scope) for the M2M tool surface. The human owner never gets `payment_intent:propose` / `*:execute`. Money movement is an agent + §6-gate concern.
{% endhint %}

### 1. Sign up

```bash
curl -sX POST "$BRAIN/v1/signup" -H 'content-type: application/json' \
  -d '{"email":"founder@example.com","password":"a-strong-passphrase-12+"}'
# → 201 { "tenant_id":"tnt_…", "user_id":"user_…", "status":"pending",
#         "verification_token":"…" }   # returned outside production; emailed in prod
```

Password is min 12 chars (stored as a scrypt hash). A duplicate email returns `409 signup_email_taken`.

### 2. Verify your email

```bash
curl -sX POST "$BRAIN/v1/auth/verify-email" -H 'content-type: application/json' \
  -d '{"tenant_id":"tnt_…","token":"<verification_token>"}'
# → 200 { "verified": true, "status": "active" }
```

Single-use, short-TTL token scoped to your tenant.

### 3. Log in for an owner token

```bash
curl -sX POST "$BRAIN/v1/auth/login" -H 'content-type: application/json' \
  -d '{"email":"founder@example.com","password":"a-strong-passphrase-12+"}'
# → 200 { "access_token":"eyJ…", "expires_in":900,
#         "principal": { "type":"user", "scopes":["ledger:read","wiki:read",
#           "policy:read","policy:write","audit:read","execution:read","payment_intent:approve"] } }
```

Use it as a bearer token. It's tenant-scoped (RLS) and 15-minute-lived; log in again to refresh.

```bash
curl -s "$BRAIN/v1/ledger/accounts" -H "authorization: Bearer $ACCESS_TOKEN"
```

### 4. Bring in a wallet or an agent

- **Link your own wallet** (so you can also sign in with it): `POST /v1/tenants/{tenant_id}/wallets` with your owner token. A wallet-based sign-in then mints the same owner token via SIWX.
- **Point an agent at Brain**: register the agent (it lands `pending_onchain`, becomes `active` once its `BrainMCPAgentRegistry` scope attestation confirms), then the agent signs in with SIWX and calls the MCP surface. Read, contribute, and **propose** (never execute; every settlement passes the §6 gate).

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔌 Let an External Agent In</strong></td><td>Authorize an MCP agent to read and propose.</td><td><a href="let-an-external-agent-in.md">let-an-external-agent-in.md</a></td><td></td></tr><tr><td><strong>💸 Pay an Invoice Safely</strong></td><td>Propose → approve → execute → receipt.</td><td><a href="pay-an-invoice-safely.md">pay-an-invoice-safely.md</a></td><td></td></tr><tr><td><strong>🔑 Authentication</strong></td><td>The full credential + token reference.</td><td><a href="../api-reference/authentication.md">authentication.md</a></td><td></td></tr></tbody></table>
