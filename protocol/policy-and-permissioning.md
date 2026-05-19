# Policy and Permissioning

Tenants describe policy in **plain English**. The Policy compiler converts each policy into a deterministic guard expression that is evaluated for every proposed action. Policies are versioned and signed by the tenant via EIP-712, with hashes anchored on-chain through `BrainPolicyRegistry`.

### Plain English in, deterministic guard out

You write the policy in natural language. Brain compiles it. You sign the compiled form, not the prose.

```
Allow invoice payments under $5,000 to approved vendors,
require approval above $5,000,
and block payments to new counterparties without review.
```

Compiles to:

```json
{
  "subject":  { "agent_capability": "pay_invoice" },
  "resource": { "counterparty.status": ["approved"] },
  "rules": [
    { "if": "amount < 5000 && counterparty.known",
      "then": "ALLOW" },
    { "if": "amount >= 5000 && counterparty.known",
      "then": "ESCALATE", "approvers": ["role:cfo"] },
    { "if": "!counterparty.known",
      "then": "DENY", "reason": "new_counterparty_review_required" }
  ]
}
```

{% hint style="warning" %}
The compiler emits both the deterministic compiled policy **and** a human-readable explanation of what it will do. **Tenants sign the compiled form, not the prose.** This eliminates ambiguity at the moment of signing.
{% endhint %}

### The five elements of a policy

Every policy has five elements.

| Element        | What It Defines                                                              |
| -------------- | ---------------------------------------------------------------------------- |
| **Subjects**   | Which agents, capabilities, or roles the policy applies to                   |
| **Resources**  | Which accounts, counterparties, asset classes, or jurisdictions are in scope |
| **Actions**    | What is permitted: read, propose, execute, approve                           |
| **Conditions** | Thresholds, time windows, frequency caps, required approvers                 |
| **Outcomes**   | ALLOW, DENY, or ESCALATE                                                     |

### The three outcomes

Every policy evaluation produces exactly one of three outcomes.

<table data-view="cards"><thead><tr><th></th><th></th></tr></thead><tbody><tr><td><strong>✅ ALLOW</strong></td><td>The action proceeds. A signed policy verdict is attached to the resulting UserOperation or rail call.</td></tr><tr><td><strong>⚠️ ESCALATE</strong></td><td>Human approval is required before the action can execute. The verdict names the required approvers (e.g. <code>role:cfo</code>).</td></tr><tr><td><strong>❌ DENY</strong></td><td>The action is blocked. The verdict carries a structured reason (e.g. <code>new_counterparty_review_required</code>).</td></tr></tbody></table>

{% hint style="info" %}
**ESCALATE is the default for unmatched conditions.** If the policy compiler cannot determine a clear ALLOW or DENY for a proposed action, the safe default is to require human review. Failure modes are explicit, not silent.
{% endhint %}

### Worked example: the $7,800 invoice

A walkthrough of the policy from the top of this page, applied to a real proposal:

| Step | What Happens                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Agent proposes: pay $7,800 invoice to Vendor X                                                                                    |
| 2    | Policy Layer evaluates against version `v3` of the tenant policy                                                                  |
| 3    | Counterparty Vendor X: known, status = approved                                                                                   |
| 4    | Amount $7,800: above $5,000 threshold                                                                                             |
| 5    | Outcome: `ESCALATE_FOR_APPROVAL`, approvers = `[role:cfo]`                                                                        |
| 6    | CFO receives the request with Wiki context (vendor history, prior payments) and Ledger references (invoice, PO)                   |
| 7    | CFO approves. EIP-712 approval signature recorded                                                                                 |
| 8    | Action moves to executable. `BrainSmartAccount` signs UserOperation OR bank API call dispatched                                   |
| 9    | Audit Layer records: proposal, policy decision, approver identity, execution receipt, settlement confirmation, all linked by hash |

### Versioning, signing, and anchoring

Every policy version has a lifecycle.

```
draft → compile → review → sign (EIP-712) → anchor on-chain → active
```

| Phase       | What Happens                                                        |
| ----------- | ------------------------------------------------------------------- |
| **Draft**   | Plain-English text written in the Console or via API                |
| **Compile** | Compiler produces deterministic JSON + a human-readable explanation |
| **Review**  | Tenant reviews the compiled form                                    |
| **Sign**    | Tenant signs the canonical hash via EIP-712 `PolicyRegistration`    |
| **Anchor**  | Hash is registered in `BrainPolicyRegistry` on Base L2              |
| **Active**  | The policy version is active until superseded or revoked            |

The signed structure:

```
PolicyRegistration(
  bytes32 tenantId,
  uint64  version,
  bytes32 policyHash,
  uint64  notBefore,
  uint64  notAfter,
  uint256 nonce
)
```

[**→ Smart contract reference**](/broken/pages/ia2C5LyWlDxEqxJuu710)

### How policy enforcement is layered

Policy is enforced **twice** by design.

| Level                             | What It Catches                                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Off-chain** Brain Policy Engine | Most evaluations, fast feedback, dynamic conditions, rich error messages                                                                                                          |
| **On-chain** `BrainSmartAccount`  | The signed Policy verdict is verified inside `validateUserOp`. Any action without a valid verdict is rejected at the account level, regardless of what the off-chain engine said. |

{% hint style="success" %}
Belt and braces. Even if the off-chain engine were compromised, the on-chain account would still reject UserOperations that lack a valid, non-expired, scope-bound policy verdict.
{% endhint %}

Policy verdicts are short-lived (default TTL 60 seconds) and bound to the `userOpHash`, so a verdict cannot be replayed against a different action.

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🤖 Agents</strong></td><td>How agents propose actions and receive scope grants.</td><td><a href="agents.md">agents.md</a></td><td></td></tr><tr><td><strong>📜 Audit and Proof</strong></td><td>How every policy decision is captured.</td><td><a href="audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr><tr><td><strong>📜 BrainPolicyRegistry</strong></td><td>The on-chain anchor.</td><td><a href="../smart-contracts/brainpolicyregistry.md">brainpolicyregistry.md</a></td><td></td></tr></tbody></table>
