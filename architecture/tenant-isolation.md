# Tenant Isolation

Each tenant has its own logical instance of every layer, with hard isolation at the database, storage path, and policy boundaries. **Cross-tenant access is impossible by construction**, not by application-level access control.

### Isolation by Layer

| Layer        | Isolation Mechanism                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| **Raw**      | Azure Blob paths namespaced by `tenantId`. Source credentials use AES-256-GCM at the application boundary. |
| **Ledger**   | Logical partitions in Postgres. All queries forced through tenant scope.                                   |
| **Wiki**     | Separate graph per tenant. Embeddings indexed within tenant scope only.                                    |
| **Policy**   | One active policy per tenant. Policy verdicts include `tenantId` in their signed payload.                  |
| **Agent**    | Scope grants are per-tenant. An agent active for tenant A has zero visibility into tenant B.               |
| **Audit**    | Per-tenant hash chains. Per-tenant Merkle trees. Per-tenant anchored roots.                                |
| **Surfaces** | Slack, Teams, and email identities link to Brain actors through tenant-scoped RLS tables.                  |

### Encryption Posture

```
Azure Key Vault secret or BRAIN_SOURCE_CREDENTIAL_KEY
   └── Global AES-256-GCM source-credential key
         └── Encrypted source credentials in Postgres
```

| Property                    | Detail                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Credential key location** | Azure Key Vault secret in production when configured, or `BRAIN_SOURCE_CREDENTIAL_KEY` outside prod.       |
| **Algorithm**               | AES-256-GCM in `shared/src/crypto/credential-key-provider.ts`.                                             |
| **Scope**                   | One global source-credential key today. Tenant-scoped envelope keys are not implemented.                   |
| **Compromise blast radius** | Tenant isolation relies on RLS, tenant-prefixed storage paths, and policy boundaries, not per-tenant keys. |

### Customer-Managed KMS

Customer-managed tenant keys are a planned enterprise hardening item, not a
shipped capability.

| Status      | Detail                                                             |
| ----------- | ------------------------------------------------------------------ |
| **Current** | Brain-managed source-credential encryption key.                    |
| **Planned** | Customer-managed key support for enterprise tenants before launch. |

### RBAC Across Humans and Agents

Every API call is scoped by tenant, role, and policy. Agents are subjects in the same RBAC graph as humans. There is no special case for agent calls.

```
Subject (human user OR agent address)
   ↓
Tenant membership (with role)
   ↓
Policy scope (which capabilities, which resources)
   ↓
Action evaluation
   ↓
ALLOW / ESCALATE / DENY
```

| Subject Type       | Identified By        | Authenticated By                   |
| ------------------ | -------------------- | ---------------------------------- |
| **Human**          | User ID              | Email + password, or wallet (SIWX) |
| **Internal agent** | Service principal ID | Service credentials                |
| **External agent** | Agent address        | SIWX (EIP-4361 over Base)          |

### Surface Gateway Role

Slack, Teams, and email approval webhooks run in `services/surface-gateway`, not
inside the core API process. The production role is `brain_surface_gateway`:

| Property      | Detail                                                                         |
| ------------- | ------------------------------------------------------------------------------ |
| **RLS**       | Enabled and forced on surface tables. The role has no `BYPASSRLS`.             |
| **Writes**    | `surface_*` tables and approval rows only.                                     |
| **Reads**     | Linked surface identities, users, and active policy rows.                      |
| **No access** | No Ledger money-path grants and no `execution_outbox` grants.                  |
| **Secrets**   | Slack, Teams, and email provider credentials stay out of the core API process. |

### On-Chain Isolation

On-chain commitments are also tenant-isolated.

| Contract                | How Tenants Are Separated                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `BrainAuditAnchor`      | All functions take `bytes32 tenantId`. Roots and batch indices stored per tenant.                             |
| `BrainPolicyRegistry`   | Policy versions stored per `tenantId`. EIP-712 signatures bind to a specific tenant.                          |
| `BrainMCPAgentRegistry` | Scope grants stored as `(tenantId, agent, capability)`. An agent scoped for tenant A cannot act for tenant B. |
| `BrainSmartAccount`     | One smart account contract per tenant. Each enforces its tenant's policy via the on-chain verifier.           |

{% hint style="success" %}
Cross-tenant access is impossible at the protocol level, not just the application level. There is no "share data with another tenant" code path because there is no code path that accepts a foreign `tenantId`.
{% endhint %}

### Data Minimisation

Brain ingests only what enabled capabilities require. Revoking a source triggers retention and deletion workflows.

| When                         | What Happens                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Source connected**         | Only the agreed scope of data flows from that source                                                 |
| **Source disconnected**      | New data stops; existing data enters a retention window                                              |
| **Retention window expires** | Raw artifacts deleted (Azure Blob lifecycle); Ledger records marked closed; Wiki references redacted |
| **Tenant deletion request**  | Full tenant erasure across tenant-scoped rows and storage prefixes                                   |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Security and Compliance</strong></td><td>Non-negotiable principles, compliance posture.</td><td><a href="security-and-compliance.md">security-and-compliance.md</a></td><td></td></tr><tr><td><strong>Risks and Mitigations</strong></td><td>Known risks and how Brain handles them.</td><td><a href="risks-and-mitigations.md">risks-and-mitigations.md</a></td><td></td></tr></tbody></table>
