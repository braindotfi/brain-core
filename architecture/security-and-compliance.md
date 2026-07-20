# Security and Compliance

Brain's security posture rests on a small set of non-negotiable principles. Each one shapes the architecture.

### Non-Negotiable Principles

<table data-view="cards"><thead><tr><th></th><th></th></tr></thead><tbody><tr><td><strong>Non-Custodial</strong></td><td>Brain never takes custody of customer funds. Money flows directly between the tenant's accounts and counterparties on the tenant's chosen rails.</td></tr><tr><td><strong>Tenant-Isolated</strong></td><td>Each tenant has dedicated logical database partitions and tenant-prefixed object paths. Source credentials are encrypted with a global AES-256-GCM key loaded from Azure Key Vault in production.</td></tr><tr><td><strong>Data Minimization</strong></td><td>Brain ingests only what enabled capabilities require. Revoking a source triggers retention and deletion workflows.</td></tr><tr><td><strong>RBAC Across Humans and Agents</strong></td><td>Every API call is scoped by tenant, role, and policy. Agents are subjects in the same RBAC graph as humans.</td></tr><tr><td><strong>Human Approval Thresholds</strong></td><td>Any action above a tenant-defined threshold, any new counterparty, or any new jurisdiction can require human sign-off before execution.</td></tr><tr><td><strong>Compliance Ready</strong></td><td>The pre-execution gate blocks any counterparty an operator has flagged as sanctioned and can require verification before money moves. Live third-party screening (Chainalysis and equivalents) is planned, not yet integrated.</td></tr></tbody></table>

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

| Layer                                   | Where It Runs       | What It Catches                                                                                                                 |
| --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **1. Backend Policy Engine**            | Off-chain           | Most violations, fast feedback, dynamic risk conditions                                                                         |
| **2. Counterparty risk checks**         | Off-chain           | The gate rejects a counterparty whose operator-set `risk_level` is `sanctioned` and enforces the policy verification threshold  |
| **3. On-chain session-key enforcement** | `BrainSmartAccount` | Final gate. `executeViaSessionKey` enforces the key's scope (target/selector allowlists), spend caps, and bound `policyVersion` |

```
Agent proposes
   ↓
[ Gate 1: Policy Engine ]    ← signed verdict produced if allow
   ↓
[ Gate 2: Counterparty risk ]  ← operator-set sanctioned / verified checks
   ↓
[ Gate 3: BrainSmartAccount.executeViaSessionKey ]  ← on-chain
   ↓
Executes
```

{% hint style="warning" %}
**Defence in depth.** Even if the off-chain Policy Engine were fully compromised, the on-chain `BrainSmartAccount` would still reject any call outside the granted session key's policyVersion-bound scope and spend caps.
{% endhint %}

### Counterparty Risk Attributes

Sanctions and risk are operator-set attributes on the counterparty record, read by the pre-execution gate. They are not produced by a live third-party screening call in the current build.

| Attribute            | Source                          | What It Gates                                                        |
| -------------------- | ------------------------------- | -------------------------------------------------------------------- |
| **`risk_level`**     | Operator-set ledger field       | A value of `sanctioned` is a hard reject at the gate                 |
| **`verified_status`**| Operator-set ledger field       | Enforces the policy counterparty-verification threshold above an amount |
| **Anomaly detection**| Brain internal                  | Statistical outliers vs tenant's baseline                           |

The gate reads these fields directly: it rejects a counterparty whose `risk_level` is `sanctioned`, and above a policy threshold it requires `verified_status` to be `document_verified` or `sanctions_cleared`. Live third-party screening (Chainalysis and equivalents) that would populate these fields automatically is planned, not yet integrated.

### Smart Contract Security

| Mitigation                        | Detail                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Minimal on-chain surface**      | Most logic off-chain. Less code = smaller attack surface                                                                      |
| **External audit before mainnet** | No money-moving contract ships to mainnet without an external audit; testnet/reference contracts are clearly marked unaudited |
| **Public bug bounty**             | Continuous coverage post-deployment                                                                                           |
| **Immutable contracts**           | No upgrade path in MVP; changes ship as audited redeploys                                                                     |
| **Anchorer key hardening**        | Current testnet publisher is a single EOA; HSM-backed signing is a pre-mainnet TODO                                           |
| **Session-key enforcement**       | On-chain scope, spend caps, `policyVersion` binding, and replay nonce enforced in `executeViaSessionKey`                      |

Additional Tier 0 hardening now makes the escrow audit gate non-testnet-wide,
checks explicit `BASE_RPC_URL` chain id at boot, rejects ERC20 selectors in
native-mode session-key grants, and replay-protects agent behavior updates and
revocations with per-agent EIP-712 nonces.

### Privacy of Audit Anchors

On-chain anchors must not leak tenant data.

```
On-chain (public):
  - Merkle roots
  - Hashed tenantId
  - Anchor timestamp
  - Event count and period bounds (periodStart, periodEnd)

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

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Tenant isolation</strong></td><td>How separation is enforced at every layer.</td><td><a href="tenant-isolation.md">tenant-isolation.md</a></td><td></td></tr><tr><td><strong>Risks and mitigations</strong></td><td>Known risks and how Brain handles them.</td><td><a href="risks-and-mitigations.md">risks-and-mitigations.md</a></td><td></td></tr><tr><td><strong>Smart contracts</strong></td><td>The on-chain enforcement layer.</td><td><a href="../smart-contracts/overview.md">overview.md</a></td><td></td></tr></tbody></table>
