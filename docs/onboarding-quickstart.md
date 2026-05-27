# Onboarding quickstart (self-serve)

How a developer goes from nothing to an authenticated tenant with Brain's
self-serve onboarding (RFC 0002). This is the **human** path; pointing an
autonomous **agent** at Brain is the SIWX + on-chain registration path (separate,
see §"Agents" below).

> **Status / safety.** Self-serve signup is gated by the `BRAIN_SELF_SERVE_SIGNUP`
> flag (default **off** — the routes don't exist unless enabled). Every new tenant
> is **sandbox-only**: it can read and _propose_, but moves **no money**. Real
> settlement stays behind the existing promotion + external-audit gates. Email
> delivery is not wired yet — outside production the verification token is
> returned in the signup response.

## The two principals

| Principal           | Identity                                                           | Use it for                                                             |
| ------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Human owner**     | email + password                                                   | tenant management, reads, approving payment intents (a management JWT) |
| **Agent** (machine) | wallet (SIWX) + on-chain `BrainMCPAgentRegistry` scope attestation | the M2M / MCP tool surface (propose, reads, contribute)                |

The owner JWT carries **management/read/approve scopes only** — never
`payment_intent:propose`, `payment_intent:execute`, or `execution:propose`. Money
movement is an agent + §6-gate concern, never a human-login capability.

## 1. Sign up (provision a sandbox tenant + owner)

```bash
curl -sX POST "$BRAIN/v1/signup" \
  -H 'content-type: application/json' \
  -d '{"email":"founder@example.com","password":"a-strong-passphrase-12+"}'
```

```json
{
  "tenant_id": "tnt_…",
  "user_id": "user_…",
  "status": "pending",
  "verification_token": "…" // non-prod only; emailed in production
}
```

- Password: min 12 chars (stored as a scrypt hash; never logged).
- Duplicate email → `409 signup_email_taken`.

## 2. Verify the email (activate the owner)

```bash
curl -sX POST "$BRAIN/v1/auth/verify-email" \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"tnt_…","token":"<verification_token>"}'
```

```json
{ "verified": true, "user_id": "user_…", "status": "active" }
```

- Single-use, short-TTL token, scoped to your `tenant_id`. Invalid/expired/used →
  `400 signup_token_invalid`.

## 3. Log in (get a management JWT)

```bash
curl -sX POST "$BRAIN/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"founder@example.com","password":"a-strong-passphrase-12+"}'
```

```json
{
  "access_token": "eyJ…",
  "token_type": "Bearer",
  "expires_in": 900,
  "principal": {
    "id": "user_…",
    "type": "user",
    "tenantId": "tnt_…",
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

- Unknown email and wrong password return the **same** `401
auth_invalid_credentials` (no user enumeration). Unverified account → `403
auth_email_unverified`.

## 4. Use the API

```bash
curl -s "$BRAIN/v1/ledger/accounts" -H "authorization: Bearer $ACCESS_TOKEN"
```

The token is tenant-scoped (RLS) and 15-minute-lived. Refresh by logging in again.

## Agents (machine principals)

To run an autonomous agent against the MCP surface (`POST /v1/agents/mcp`), the
agent registers on-chain in `BrainMCPAgentRegistry` with an EIP-712 scope
attestation and authenticates via SIWX (`POST /v1/auth/siwx/challenge` →
`/v1/auth/siwx`). The agent can read, contribute evidence, and **propose**
payment intents — it can never `execute` (there is no execute tool; every
settlement passes the §6 gate). Turnkey agent self-registration
(`POST /v1/agents` + async on-chain relayer) is RFC 0002 Phase C — in progress.

## Reference

- OpenAPI: the `Auth` tag in `Brain_API_Specification.yaml` (`/signup`,
  `/auth/verify-email`, `/auth/login`).
- Design + safety model: `docs/rfcs/0002-self-serve-onboarding.md`.
