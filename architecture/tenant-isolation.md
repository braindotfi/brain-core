# Tenant Isolation

Each tenant has its own logical instance of every layer, with hard isolation at the database, KMS, and policy boundaries. **Cross-tenant access is impossible by construction**, not by application-level access control.

### Isolation by Layer

| Layer        | Isolation Mechanism                                                                           |
| ------------ | --------------------------------------------------------------------------------------------- |
| **Raw**      | Azure Blob paths namespaced by `tenantId`. Every artifact encrypted with a tenant-scoped DEK. |
| **Ledger**   | Logical partitions in Postgres. All queries forced through tenant scope.                      |
| **Wiki**     | Separate graph per tenant. Embeddings indexed within tenant scope only.                       |
| **Policy**   | One active policy per tenant. Policy verdicts include `tenantId` in their signed payload.     |
| **Agent**    | Scope grants are per-tenant. An agent active for tenant A has zero visibility into tenant B.  |
| **Audit**    | Per-tenant hash chains. Per-tenant Merkle trees. Per-tenant anchored roots.                   |
| **Surfaces** | Slack, Teams, and email identities link to Brain actors through tenant-scoped RLS tables.     |

### Encryption Hierarchy

```
Azure Key Vault
   └── Tenant KEK (Key Encryption Key)         ← per-tenant
         └── Tenant DEK (Data Encryption Key)  ← per-tenant, rotates
               └── Encrypted artifacts in Azure Blob
               └── Encrypted ledger fields in Postgres
```

| Property                    | Detail                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| **KEK location**            | Azure Key Vault, customer-managed for enterprise tenants                                         |
| **DEK rotation**            | Periodic, transparent to applications                                                            |
| **DEK wrapping**            | Each DEK wrapped by the tenant KEK. Compromise of one tenant cannot decrypt another              |
| **Compromise blast radius** | A single compromised DEK exposes only the data encrypted with it, never the KEK or other tenants |

### Customer-Managed KMS

Enterprise tenants can bring their own KEK in their own KMS account.

|                                  | Brain-managed KEK             | Customer-managed KEK                   |
| -------------------------------- | ----------------------------- | -------------------------------------- |
| **KEK location**                 | Brain's Azure Key Vault       | Customer's Azure Key Vault             |
| **Brain has access to KEK**      | Yes (operationally necessary) | No                                     |
| **Tenant can revoke decryption** | Via support                   | Instantly, by removing Brain's grant   |
| **Compliance posture**           | SOC 2 + standard isolation    | "Brain cannot read our data" guarantee |

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
| **Tenant deletion request**  | Full tenant erasure, including off-chain DEKs (which renders any persisted ciphertext unreadable)    |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛡️ Security and Compliance</strong></td><td>Non-negotiable principles, compliance posture.</td><td><a href="security-and-compliance.md">security-and-compliance.md</a></td><td></td></tr><tr><td><strong>⚠️ Risks and Mitigations</strong></td><td>Known risks and how Brain handles them.</td><td><a href="risks-and-mitigations.md">risks-and-mitigations.md</a></td><td></td></tr></tbody></table>
