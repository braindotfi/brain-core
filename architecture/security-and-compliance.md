# Security and Compliance

Brain's security posture rests on a small set of non-negotiable principles. Each one shapes the architecture.

### Non-Negotiable Principles

<table data-view="cards"><thead><tr><th></th><th></th></tr></thead><tbody><tr><td><strong>🔒 Non-Custodial</strong></td><td>Brain never takes custody of customer funds. Money flows directly between the tenant's accounts and counterparties on the tenant's chosen rails.</td></tr><tr><td><strong>🔐 Tenant-Isolated</strong></td><td>Each tenant has dedicated logical partitions and DEKs wrapped by tenant-scoped KEKs in Azure Key Vault. Cross-tenant access is impossible by construction.</td></tr><tr><td><strong>📉 Data Minimization</strong></td><td>Brain ingests only what enabled capabilities require. Revoking a source triggers retention and deletion workflows.</td></tr><tr><td><strong>🪪 RBAC Across Humans and Agents</strong></td><td>Every API call is scoped by tenant, role, and policy. Agents are subjects in the same RBAC graph as humans.</td></tr><tr><td><strong>✋ Human Approval Thresholds</strong></td><td>Any action above a tenant-defined threshold, any new counterparty, or any new jurisdiction can require human sign-off before execution.</td></tr><tr><td><strong>📋 Compliance Ready</strong></td><td>Sanctions screening, address risk, and anomaly enrichment run on every proposed action via Chainalysis and equivalents.</td></tr></tbody></table>

### Standards and Certifications

| Standard                  | Status                                       |
| ------------------------- | -------------------------------------------- |
| **SOC 2 Type II**         | Targeted                                     |
| **ISO 27001**             | Targeted                                     |
| **Customer-managed KMS**  | Available for tenants that require it        |
| **Smart contract audits** | Independent audits before mainnet deployment |
| **Bug bounty**            | Public coverage                              |

### Three Layers of Action Gating

Every proposed action passes through three independent gates. **All three must pass.**

| Layer                        | Where It Runs       | What It Catches                                                                         |
| ---------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| **1. Backend Policy Engine** | Off-chain           | Most violations, fast feedback, dynamic risk conditions                                 |
| **2. Compliance enrichment** | Off-chain           | Sanctions screening (Chainalysis), address risk, anomaly detection                      |
| **3. On-chain validator**    | `BrainSmartAccount` | Final gate. Verifies signed policy verdict, scope attestation, and account-level limits |

```
Agent proposes
   ↓
[ Gate 1: Policy Engine ]    ← signed verdict produced if ALLOW
   ↓
[ Gate 2: Compliance ]       ← sanctions / risk / anomaly checks
   ↓
[ Gate 3: BrainSmartAccount.validateUserOp ]  ← on-chain
   ↓
Executes
```

{% hint style="warning" %}
**Defence in depth.** Even if the off-chain Policy Engine were fully compromised, the on-chain `BrainSmartAccount` would still reject UserOperations that lack a valid, non-expired, scope-bound policy verdict.
{% endhint %}

### Compliance Enrichment

Every proposed action that involves a payment is enriched with compliance data before policy evaluation.

| Check                   | Provider Type                 | What It Catches                                                      |
| ----------------------- | ----------------------------- | -------------------------------------------------------------------- |
| **Sanctions screening** | Chainalysis (and equivalents) | OFAC, UN, EU, UK lists                                               |
| **Address risk**        | Chain analytics               | High-risk wallets, mixer exposure, sanctioned counterparty proximity |
| **Anomaly detection**   | Brain internal                | Statistical outliers vs tenant's baseline                            |

The output of these checks feeds directly into Policy. A tenant policy can reference `counterparty.risk_score` or `counterparty.sanctions_status` like any other field.

### Smart Contract Security

| Mitigation                       | Detail                                                         |
| -------------------------------- | -------------------------------------------------------------- |
| **Minimal on-chain surface**     | Most logic off-chain. Less code = smaller attack surface       |
| **Two independent audits**       | Performed before mainnet deployment                            |
| **Public bug bounty**            | Continuous coverage post-deployment                            |
| **48-hour timelock on upgrades** | Transparent proxy pattern, upgrades are visible and delayed    |
| **Anchorer keys on HSMs**        | Hardware-backed signing for `BrainAuditAnchor`                 |
| **EntryPoint isolation**         | Uses standard ERC-4337 EntryPoint; no custom verification path |

### Privacy of Audit Anchors

On-chain anchors must not leak tenant data.

```
On-chain (public):
  - Merkle roots
  - Hashed tenantId
  - Anchor timestamp
  - Anchorer EIP-712 signature

Off-chain (encrypted):
  - Event payloads
  - Raw artifacts
  - Ledger records, Wiki entities
  - Policy text and compiled rules
```

A counterparty verifying a Brain audit proof receives only the specific event(s) the tenant chooses to share, plus the Merkle path. **Nothing else is exposed.**

[**→ Audit and Proof in detail**](../protocol/audit-and-proof.md)

### Human Approval Thresholds

Tenants define when humans must be in the loop. Every threshold is enforced at policy evaluation time.

| Trigger                                  | Default Behaviour           |
| ---------------------------------------- | --------------------------- |
| **Action above threshold**               | ESCALATE to named approvers |
| **New counterparty**                     | DENY until reviewed         |
| **New jurisdiction**                     | DENY until reviewed         |
| **Outside time window**                  | DENY                        |
| **Outside tenant-defined frequency cap** | DENY                        |

These are configurable per tenant. The defaults err on the side of human review.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔒 Tenant isolation</strong></td><td>How separation is enforced at every layer.</td><td><a href="tenant-isolation.md">tenant-isolation.md</a></td><td></td></tr><tr><td><strong>⚠️ Risks and mitigations</strong></td><td>Known risks and how Brain handles them.</td><td><a href="risks-and-mitigations.md">risks-and-mitigations.md</a></td><td></td></tr><tr><td><strong>📜 Smart contracts</strong></td><td>The on-chain enforcement layer.</td><td><a href="../smart-contracts/overview.md">overview.md</a></td><td></td></tr></tbody></table>
