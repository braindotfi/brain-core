# Agent API Key Exchange

This contract defines the additive Phase 1 machine authentication path. It does
not change commercial `brain_sk_*` authentication, current long-lived agent
JWTs, or `POST /v1/tenants/{tenantId}/agent-token`.

## Credential model

Agent credentials use `brain_ak_test_*` or `brain_ak_live_*`. They are accepted
only as `subject_token` at `POST https://auth.brain.fi/token`. API resource
routes reject direct use before invoking either the commercial API-key or JWT
authenticator.

The plaintext key is returned once. `agent_api_keys` stores a digest produced by
HMAC-SHA-256 with `BRAIN_AGENT_API_KEY_PEPPER`, which must be distinct from
`BRAIN_API_KEY_PEPPER`. Keys expire after 90 days and can be revoked or rotated.
Rotation atomically revokes the prior key and returns one replacement plaintext.
Issuance accepts an optional tenant-scoped `Idempotency-Key`; matching retries
replay the original response for 24 hours, while a different body conflicts.

The platform-managed issuance profiles are server-owned:

- `document_extractor_v1`: exactly `raw:write`
- `bff_service_v1`: exactly `BFF_SERVICE_AGENT_SCOPES`

Issuance accepts no caller-selected scopes. Exchange may narrow a profile scope
set but can never widen it. The bound agent must remain active and internal.

## RFC 8693 request

The token endpoint accepts `application/x-www-form-urlencoded` with:

- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
- `subject_token=<brain_ak_*>`
- `subject_token_type=urn:brain:params:oauth:token-type:agent-api-key`
- optional `requested_token_type=urn:ietf:params:oauth:token-type:access_token`
- `resource=https://api.brain.fi/`
- optional `scope`, limited to a subset of the bound profile

The response contains `access_token`, `issued_token_type`, `token_type`,
`expires_in`, and `scope`. It never contains a refresh token.

## Exchanged access tokens

Exchanged JWTs:

- expire after 300 seconds
- use the exact API resource as `aud`
- use the bound agent as `sub` and `principal_type=agent`
- carry the tenant and server-owned scopes
- carry `credential_id=agkey_*` for audit attribution

Malformed, unknown, expired, revoked, environment-mismatched, scope-tampered,
or inactive credentials fail with a generic token-endpoint error. Secret values
must never be logged. Rate limits key valid-looking requests by public credential
id plus source IP, and malformed requests by source IP.

## Deployment gate

`BRAIN_AGENT_KEY_EXCHANGE_ENABLED` defaults to false. Enabling it requires both
`BRAIN_AGENT_API_KEY_PEPPER` and `BRAIN_AGENT_KEY_ENVIRONMENT`. The API resource
is configured by `BRAIN_API_RESOURCE_URL`. With the feature disabled, issuance
routes are absent and the token endpoint returns `unsupported_grant_type` for
the exchange grant.
