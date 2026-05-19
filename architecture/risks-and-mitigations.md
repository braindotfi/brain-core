# Risks and Mitigations

A frank inventory of the technical risks Brain faces and how the architecture addresses each one.

### Source Data Quality

**Risk.** Bank feeds and emails contain noise and gaps. An invoice arrives in five formats. Counterparty names vary across sources. Reconciliation is genuinely hard.

**Mitigation.**

| Mechanism                                       | How It Helps                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| Deterministic extractors with confidence scores | Low-confidence records flagged for review, not silently absorbed      |
| Replayable Raw layer                            | If the extractor improves, every higher layer can be rebuilt from Raw |
| Human-in-the-loop reconciliation queue          | Low-confidence records routed to a human before they affect Wiki      |

### Agent Misbehaviour

**Risk.** A buggy or malicious agent could attempt unauthorized actions: overspending, paying the wrong counterparty, looping requests.

**Mitigation.**

| Mechanism                                | How It Helps                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| EIP-712 ScopeAttestation                 | Every action requires a tenant-signed scope; outside-scope calls fail at the on-chain validator |
| Signed policy verdict                    | Every action requires a Brain-signed verdict bound to the userOpHash                            |
| `BrainSmartAccount` enforcement on-chain | Both checks happen inside `validateUserOp`, not just in the backend                             |
| Account-level limits (per-tx, per-day)   | Hard cap on blast radius regardless of policy                                                   |
| ERC-8004 reputation                      | Misbehaving agents accumulate negative attestations and lose access                             |

### Policy Ambiguity

**Risk.** Plain-English policies can be ambiguous. "Allow recurring payments to known vendors". What counts as recurring? What counts as known?

**Mitigation.**

| Mechanism                                        | How It Helps                                                |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Compiler emits deterministic compiled policy     | The signed form is unambiguous JSON, not prose              |
| Compiler also emits an explanation               | Tenants see exactly what they are signing in human terms    |
| Tenants sign the compiled form                   | Eliminates "but I meant..." disputes                        |
| ESCALATE is the default for unmatched conditions | Edge cases route to humans, not silent ALLOW or silent DENY |

### Source API Failures and Rate Limits

**Risk.** Upstream banks and processors have downtime, rate limits, and silent data loss.

**Mitigation.**

| Mechanism                        | How It Helps                                                      |
| -------------------------------- | ----------------------------------------------------------------- |
| Idempotent ingestion             | Repeated webhooks or pulls produce the same Raw artifact          |
| Retries with exponential backoff | Transient failures recover automatically                          |
| Replay from Raw                  | If an extractor needs to re-run, no need to re-pull from upstream |

### Smart Contract Risk

**Risk.** Bugs in `BrainSmartAccount` or `BrainAuditAnchor` could compromise execution or audit integrity.

**Mitigation.**

| Mechanism                    | How It Helps                                                 |
| ---------------------------- | ------------------------------------------------------------ |
| Minimal on-chain surface     | Less code = smaller attack surface                           |
| Two independent audits       | Performed before mainnet deployment                          |
| Public bug bounty            | Continuous post-deployment coverage                          |
| 48-hour timelock on upgrades | Upgrades visible and delayed; tenants have time to respond   |
| Anchorer keys on HSMs        | Compromise of the operational machine does not yield the key |

### L2 Finality and Reorgs

**Risk.** Base, like any L2, can experience reorgs. An audit anchor that vanishes from the chain would be a problem.

**Mitigation.**

| Mechanism                                  | How It Helps                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Confirmations tuned per action class       | High-value actions wait for deeper confirmation                                          |
| Audit anchors reference the previous batch | Small reorg windows tolerated automatically                                              |
| Off-chain log is canonical until anchored  | Anchoring is a commitment, not a creation. The audit log exists before it lands on-chain |

### Privacy of Audit Anchors

**Risk.** Putting audit data on a public chain could leak tenant information.

**Mitigation.**

| What's On-Chain   | What Stays Off-Chain                       |
| ----------------- | ------------------------------------------ |
| Merkle roots only | Event payloads                             |
| Hashed `tenantId` | Raw artifacts                              |
| Anchor timestamps | Ledger records, Wiki entities, policy text |

A counterparty verifying a proof receives only the specific event(s) the tenant chooses to share, plus the Merkle path. Everything else stays private.

### Regulatory Variance

**Risk.** Different jurisdictions have different rules: data residency, payment licensing, sanctions enforcement, AML reporting.

**Mitigation.**

| Mechanism                                  | How It Helps                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Jurisdiction-aware policy primitives       | Policies can reference `counterparty.jurisdiction` and gate accordingly |
| Per-region deployments                     | Data residency requirements respected at the infrastructure level       |
| Partnerships with regulated counterparties | UAE first via VARA-licensed entities; EU and US to follow               |

### Risk Summary

| Risk                | Severity Without Mitigation | Severity With Mitigation                  |
| ------------------- | --------------------------- | ----------------------------------------- |
| Source data quality | High                        | Medium (always some noise)                |
| Agent misbehaviour  | Critical                    | Low (multiple gates)                      |
| Policy ambiguity    | High                        | Low (compiler + signing model)            |
| Source API failures | Medium                      | Low (idempotent + replay)                 |
| Smart contract bugs | Critical                    | Low (minimal surface + audits + timelock) |
| L2 reorgs           | Medium                      | Low (confirmations + tolerant anchors)    |
| Audit privacy leaks | High                        | Negligible (only roots on-chain)          |
| Regulatory variance | High                        | Medium (handled per-region)               |

{% hint style="info" %}
This covers only the technical risks of the threat model. Operational, governance, and business risks are addressed separately in compliance and operational documentation.
{% endhint %}

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛡️ Security and Compliance</strong></td><td>Non-negotiable principles.</td><td><a href="security-and-compliance.md">security-and-compliance.md</a></td><td></td></tr><tr><td><strong>🔒 Tenant Isolation</strong></td><td>How tenants are separated.</td><td><a href="tenant-isolation.md">tenant-isolation.md</a></td><td></td></tr><tr><td><strong>📜 Smart Contracts</strong></td><td>The on-chain enforcement layer.</td><td><a href="../smart-contracts/overview.md">overview.md</a></td><td></td></tr></tbody></table>
