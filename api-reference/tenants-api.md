# Tenants

Endpoints that operate on a tenant as a whole.

### Read Tenant Provisioning Provenance

```http
GET /v1/tenants/{id}/provenance
X-Platform-Service-Auth: <platform service secret>
```

This platform-only, read-only endpoint returns brain-core's server-owned tenant
classification. Every response includes all fields. A `null` value means the
legacy tenant is unclassified; it must never be treated as proof of customer or
non-demo data.

```json
{
  "tenant_id": "tnt_...",
  "kind": "production",
  "provisioning_state": null,
  "data_profile": "customer",
  "access_stage": "production"
}
```

Trusted synthetic provisioning reports `data_profile` as
`synthetic_brightline_v1` and `access_stage` as `demo`. The endpoint does not
derive or expose a binary `demo_seed` field. An unknown tenant returns
`404 tenant_not_found`.

### Delete a Tenant (GDPR Right-to-Erasure)

```http
DELETE /v1/tenants/{id}
Authorization: Bearer <owner JWT>
Content-Type: application/json

{ "confirm": "{tenant_id}" }
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
The caller must also hold `execution:admin`. The deletion service repeats the
authorization check inside its deletion transaction and requires the caller to
be an active admin member of the target tenant.

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
  "totalRows": 1421,
  "blobArtifactCount": 3,
  "blobUrisPendingPurge": ["tnt_.../raw/raw_001"],
  "blobPurgeJobId": "blob_purge_001"
}
```

Blob deletion is asynchronous. `blobUrisPendingPurge` lists the object-storage
artifacts captured before the database rows were removed, and `blobPurgeJobId`
identifies the separate purge job. The job id is `null` when no blobs need
purging.

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
