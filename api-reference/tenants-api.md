# Tenants

Endpoints that operate on a tenant as a whole. Today there is one: the
GDPR right-to-erasure deletion.

### Delete a Tenant (GDPR Right-to-Erasure)

```http
DELETE /v1/tenants/{id}
Authorization: Bearer <owner JWT>
```

Walks every tenant-scoped table across the six layers and deletes rows for
the target tenant under the privileged DB role (BYPASSRLS). The Merkle
audit chain itself is preserved (financial-integrity legitimate-interest
carveout); the deletion records a `tenant.deleted` event with per-table
row counts so the erasure is itself verifiable.

#### Authorization Posture

| Caller                                  | Result                               |
| --------------------------------------- | ------------------------------------ |
| User principal where `tenantId === :id` | Permitted                            |
| User principal where `tenantId !== :id` | `auth_tenant_mismatch` (HTTP 403)    |
| Agent principal                         | `auth_scope_insufficient` (HTTP 403) |
| Unauthenticated                         | `auth_token_missing` (HTTP 401)      |

Self-tenant only by design: the data subject (or their representative
user) is the authorized agent of the erasure request. No machine
credential (agent, API partner, or webhook signer) can trigger deletion.

#### Response (HTTP 200)

```json
{
  "tenantId": "tnt_...",
  "deletedRows": {
    "raw_artifacts": 1240,
    "ledger_payment_intents": 32,
    "wiki_pages": 18,
    "policy_decisions": 47,
    "agents": 3,
    "...": "..."
  },
  "totalRows": 1421
}
```

#### What Is Preserved

`audit_events` and `audit_anchors` are not deleted. The Merkle chain backs
Brain's "verify without trusting Brain" promise; GDPR Article 17(3)(b)
permits retention where required for the establishment or defense of legal
claims. The tombstone `tenant.deleted` event includes a `preserved:
["audit_events", "audit_anchors"]` field so the policy is explicit on
chain.

#### Error Codes

| Code                      | HTTP | Meaning                               |
| ------------------------- | ---- | ------------------------------------- |
| `auth_token_missing`      | 401  | No JWT presented                      |
| `auth_scope_insufficient` | 403  | Principal type is not `user`          |
| `auth_tenant_mismatch`    | 403  | JWT tenant differs from target tenant |
