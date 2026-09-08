# Agent API Key Exchange

This contract defines the additive machine authentication path. Phase 1 added
issuance and exchange infrastructure. Phase 2 adds client support without
changing production credential wiring. Commercial `brain_sk_*` authentication,
current long-lived agent JWTs, and
`POST /v1/tenants/{tenantId}/agent-token` remain active until Phase 3.

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

## Phase 2 client contract

`brain-agents` accepts exactly one outbound credential mode:

- legacy `BRAIN_API_TOKEN`, retained only so Phase 2 can deploy without a live
  cutover
- `BRAIN_AGENT_API_KEY` plus `BRAIN_AUTH_TOKEN_URL`, for the Phase 3 staged
  migration

Agent-key mode exchanges during service startup and prevents the health endpoint
from becoming ready if exchange or returned-claim validation fails. The access
token remains in memory only. It refreshes 60 seconds before expiry, concurrent
refreshes share one exchange, and a resource request that receives 401 is
retried exactly once with a newly exchanged token. All outbound GET and POST
paths use this behavior. The old platform service secret and `/agent-token`
refresh path are not part of the new client.

The TypeScript SDK keeps `apiKey` as direct commercial `brain_sk_*` bearer
authentication. Its new, mutually exclusive `agentApiKey` option uses RFC 8693
exchange and the same memory-only cache, early refresh, single-flight, and one
retry rules. Server applications call `await brain.ready()` during boot. The
default token endpoint is `https://auth.brain.fi/token`; `tokenUrl`, `resource`,
and `agentScope` can be overridden for self-hosted or narrowed deployments.

Phase 3 uses `BRAIN_AGENTS_AUTH_MODE` to select one VM extraction-agent
credential. `scripts/ops/prepare-agents-auth-env.sh` renders a host-only file
containing only the selected runtime variables. The legacy JWT stays in the
shared host secret file for rollback until every agent class is migrated, while
the replacement key stays in its own mode-0600 credential file so it cannot
flow into API or worker environments derived from the shared file.

The document extractor is the first canary. Its gated workflow must compare the
pre-cutover token from the running container with the host source without
printing either, derive the actual tenant and agent binding from that runtime
token, issue the fixed `document_extractor_v1` profile, and recreate only the
agents service. Verification must then prove that the running container has no
`BRAIN_API_TOKEN`, exchange its actual key, validate the exact claims and
five-minute ceiling, confirm a forbidden `raw:read`, and complete a real ingest,
extract, parsed-write, and projection lifecycle. A failed cutover restores
legacy mode automatically.

Terraform and tenant-bound BFF agents remain on their legacy credentials during
this canary. No production-agent token is revoked and `/agent-token` remains
active until each later migration is independently confirmed.
