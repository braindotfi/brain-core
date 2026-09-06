# BrainMVB Tenant Delete Credential Runbook

BrainMVB demo TTL cleanup authenticates to the admin tenant-deletion API with a
dedicated Brain Auth JWT. The token is an `api_partner` credential carrying only
the `tenant:delete` scope. A tenant API key and the BFF shared secret are not
valid substitutes.

## Ownership and storage

Damon is the issuer and approver while the Security and Platform roles remain
assigned to him. A future delegation may split approval from execution without
changing the token contract.

Store the issued token only in the BrainMVB Replit production secret named
`BRAIN_TENANT_DELETE_JWT`. Do not store it in source control, deployment logs,
issues, chat, or BrainMVB's database. BrainMVB reads the secret only in its
server-side TTL cleanup worker and sends it as `Authorization: Bearer <token>`.

## Issue

Issue the token through an approved, interactive production operation on the
Brain production VM. Use `JwtSigner` inside `brain-prod-api`, where the existing
`AUTH_SIGN_KEY`, `AUTH_ISSUER`, and `AUTH_AUDIENCE` are already present. Never
copy the private signing JWK out of the container.

The operator supplies and records these non-secret claims in the approved change
record:

- `sub`: the stable `partner_...` identity assigned to BrainMVB TTL cleanup
- `tenant_id`: BrainMVB's control tenant, not the tenant being deleted
- `principal_type`: `api_partner`
- `scopes`: exactly `["tenant:delete"]`
- `jti`: a new `token_...` identifier for every issuance
- `iat`: issuance time
- `exp`: issuance time plus 90 days

Capture the JWT once into a mode `0600` temporary file, place its value into the
Replit production secret `BRAIN_TENANT_DELETE_JWT`, restart the BrainMVB server,
and securely erase the temporary file. Record only `sub`, `jti`, `iat`, and
`exp`, never the JWT. Validate the new credential with the read-only deletion-job
status endpoint before enabling TTL cleanup.

## Rotate

Rotate no later than day 75 so the old and new 90-day tokens can overlap during
cutover.

1. Mint a new token with the same `sub`, control `tenant_id`, and sole scope, but
   with a new `jti` and 90-day expiry.
2. Replace `BRAIN_TENANT_DELETE_JWT` in Replit and restart BrainMVB.
3. Confirm a read-only job-status request authenticates with the new token.
4. Revoke the old `jti` in Brain's Redis revocation store for its remaining
   lifetime.
5. Confirm the old token returns 401 and the new token still succeeds.

## Revoke

For a routine rotation or incident, remove or replace
`BRAIN_TENANT_DELETE_JWT` in Replit first. Then, through approved production
access, call `RedisRevocationStore.revoke(oldJti, oldExp)` against the production
Redis URL from inside `brain-prod-api`. This writes
`auth:revoked:<jti>` with a TTL ending at the token's original `exp`; API JWT
verification rejects the token immediately.

Record the reason, operator, `sub`, `jti`, expiry, and verification result in the
change or incident record. Never record the token value. If the stable partner
identity is retired, revoke every unexpired `jti` issued for it and remove the
Replit secret.
