# Production Agent Principals

Production tenants need a propose-only agent principal in addition to human members and
member sessions. This contract closes the production gap where a real company could create
a tenant, hold a bootstrap admin member, and exchange member sessions, but could not drive
agent proposal workflows because no production agent existed.

## Scope

This contract applies only to tenants with `tenant.kind = "production"` created through
`POST /v1/tenants`. Demo tenants and sandbox or testnet service-token tenants remain under
the sandbox service-token contract.

Production agent principals are machine principals. They can propose work and read the
tenant data required to propose, but they never approve, execute, sign, or administer. Human
approval authority remains exclusively with member-resolvable user sessions.

## Tenant Creation

`POST /v1/tenants` is authenticated by the platform service credential and creates, in one
tenant-scoped transaction:

1. The production tenant row.
2. The active bootstrap admin member and platform identity link.
3. The bootstrap admin member session refresh record.
4. The tenant's active `BFF Service Agent`.
5. The initial production agent token record.

The response includes the existing `tenant_id`, `member`, and `session` fields and gains an
`agent` object:

```json
{
  "tenant_id": "tnt_...",
  "member": { "id": "user_...", "role": "admin", "status": "active" },
  "session": { "token": "...", "refresh_token": "...", "expires_in": 900 },
  "agent": {
    "id": "agent_...",
    "token": "...",
    "principal_type": "agent",
    "scopes": [
      "ledger:read",
      "wiki:read",
      "raw:read",
      "raw:write",
      "policy:read",
      "execution:read",
      "execution:propose",
      "payment_intent:propose",
      "audit:read"
    ],
    "expires_in": 3600,
    "use": "propose-only agent workflows"
  }
}
```

The token is a JWT with `principal_type = "agent"`, subject equal to the created agent id,
the tenant id set to the production tenant, and the shared `SERVICE_TOKEN_SCOPES` scope set.
That shared constant is the only source of truth for the minted scope list.

## Agent Token Minting

`POST /v1/tenants/{tenant_id}/agent-token` is authenticated by the platform service
credential with required scope `tenant:agent-mint`.

The endpoint is production-only:

- It returns `404 tenant_not_found` when the tenant does not exist.
- It returns `403 production_agent_required` when the tenant is not `kind = "production"`.
- It never creates or mutates demo tenants.
- It never delegates to `POST /v1/auth/service-token`.

The endpoint returns the active production BFF agent token when one exists and has not
expired. A caller can pass `{ "rotate": true }` to revoke the active token id and mint a new
token id. Rotation revokes the prior token id through the shared JWT revocation store for the
rest of its original lifetime.

The route is idempotent for non-rotation calls: repeated calls return a bearer token for the
same active token id and do not create another agent. The returned token value itself may be
freshly signed, but the principal, token id, scopes, and expiry are the same active token
record.

## Reconciliation With Service Token

`POST /v1/auth/service-token` remains a sandbox and testnet BFF break-glass credential for
agent propose-only workflows. It must reject `tenant.kind = "production"`.

Production tenants use the production tenant routes instead:

- `POST /v1/tenants` creates the tenant's initial `BFF Service Agent` and agent token.
- `POST /v1/tenants/{tenant_id}/agent-token` returns or rotates that production agent token.

These paths are mutually exclusive by `tenant.kind`. The sandbox service-token path creates
or reuses `kind = "demo"` tenants. The production agent path requires `kind = "production"`.

## Audit

Agent token minting and rotation are audited. Audit events include tenant id, agent id, token
id, whether the token was rotated, and whether an agent or token row was created. Audit
events never include bearer token values, refresh tokens, hashes, or plaintext secrets.

## Hard Rules

1. Production agent principals remain propose-only.
2. This contract mints no token that can approve, execute, sign, or administer.
3. The minted scope set is exactly `SERVICE_TOKEN_SCOPES`.
4. `resolveActor` must continue to reject agent principals for member and approval checks.
5. Agent principals must never receive member claims.
6. Production tenants must never use `POST /v1/auth/service-token`.
7. Audit events must never carry token values.

## Invariants

1. `POST /v1/tenants` creates exactly one active bootstrap admin member and exactly one
   active production BFF service agent atomically.
2. `POST /v1/tenants` returns a member session with `principal_type = "user"` and an agent
   token with `principal_type = "agent"`.
3. Production agent tokens use the shared `SERVICE_TOKEN_SCOPES` constant and exclude
   `payment_intent:approve`, `payment_intent:execute`, `policy:sign`, and every `:admin`
   scope.
4. `POST /v1/tenants/{tenant_id}/agent-token` is idempotent without rotation and revokes the
   prior token id on rotation.
5. A production-minted agent token receives `actor_unresolved` on member and approval
   surfaces, including `GET /v1/members` and approval calls.
6. `POST /v1/auth/service-token` rejects `tenant.kind = "production"`.
