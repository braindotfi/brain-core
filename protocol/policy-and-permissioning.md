# Policy and Permissioning

Tenants describe policy in **plain English**. The Policy compiler converts each policy into a deterministic guard expression that is evaluated for every proposed action. Policies are versioned and signed by the tenant via EIP-712, with hashes anchored on-chain through `BrainPolicyRegistry`.

### Plain English in, Deterministic Guard Out

You write the policy in natural language. Brain compiles it. You sign the compiled form, not the prose.

```
Allow invoice payments under $5,000 to approved vendors,
require approval above $5,000,
and block payments to new counterparties without review.
```

Compiles to:

```json
{
  "version": 3,
  "lists": {
    "vendors.trusted": ["counterparty_approved_vendor"]
  },
  "rules": [
    {
      "id": "pay-trusted-vendors-under-5000",
      "applies_to": ["outbound_payment"],
      "when": {
        "counterparty.in": "vendors.trusted",
        "amount.lte": { "currency": "USD", "value": "5000" }
      },
      "execute": "auto"
    },
    {
      "id": "pay-trusted-vendors-over-5000",
      "applies_to": ["outbound_payment"],
      "when": {
        "counterparty.in": "vendors.trusted",
        "amount.gt": { "currency": "USD", "value": "5000" }
      },
      "require": "cfo_approval",
      "execute": "confirm"
    },
    {
      "id": "block-untrusted-counterparties",
      "applies_to": ["outbound_payment"],
      "when": { "counterparty.not_in": "vendors.trusted" },
      "execute": "reject"
    }
  ]
}
```

{% hint style="warning" %}
The compiler emits both the deterministic compiled policy **and** a human-readable explanation of what it will do. **Tenants sign the compiled form, not the prose.** This eliminates ambiguity at the moment of signing.
{% endhint %}

### The Five Elements of a Policy

Every compiled policy has a version and a set of rules. It can also define named
counterparty lists, message templates, and allowed actions for each agent.

| Element          | What It Defines                                                                  |
| ---------------- | -------------------------------------------------------------------------------- |
| **Rule id**      | A stable identifier for the rule                                                 |
| **`applies_to`** | Action categories such as `outbound_payment`, `ledger_write`, or `any`           |
| **`when`**       | Conditions such as counterparty lists, amount limits, agent role, or time window |
| **`require`**    | Optional approval requirement such as `single_signer` or `cfo_approval`          |
| **`execute`**    | `auto`, `confirm`, or `reject`                                                   |

### Execution Modes

Every matched rule uses one of three execution modes. The evaluator maps `auto`
to an allow decision when no approvers are required, or to confirm when a
`require` clause names approvers.

<table data-view="cards"><thead><tr><th></th><th></th></tr></thead><tbody><tr><td><strong>auto</strong></td><td>The evaluator returns allow unless the rule also names approvers in <code>require</code>, in which case it returns confirm.</td></tr><tr><td><strong>confirm</strong></td><td>Human approval is required before the action can execute. The rule can name the required approver roles in <code>require</code>.</td></tr><tr><td><strong>reject</strong></td><td>The evaluator blocks the action.</td></tr></tbody></table>

{% hint style="info" %}
**`reject` is the default for unmatched conditions.** If no rule matches a proposed action, the policy evaluator returns a reject decision with no matched rule id.
{% endhint %}

### Worked Example: the $7,800 Invoice

A walkthrough of the policy from the top of this page, applied to a real proposal:

| Step | What Happens                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Agent proposes: pay $7,800 invoice to Vendor X                                                                                     |
| 2    | Policy Layer evaluates against version `v3` of the tenant policy                                                                   |
| 3    | Counterparty Vendor X: known, status = approved                                                                                    |
| 4    | Amount $7,800: above $5,000 threshold                                                                                              |
| 5    | Outcome: `confirm`, approvers = `[role:cfo]`                                                                                       |
| 6    | CFO receives the request with Wiki context (vendor history, prior payments) and Ledger references (invoice, PO)                    |
| 7    | CFO approves. EIP-712 approval signature recorded                                                                                  |
| 8    | Action moves to executable. `BrainSmartAccount.executeViaSessionKey` dispatches the on-chain call OR a bank API call is dispatched |
| 9    | Audit Layer records: proposal, policy decision, approver identity, execution receipt, settlement confirmation, all linked by hash  |

### Versioning, Signing, and Anchoring

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
  uint256 version,
  bytes32 policyHash
)
```

[**→ Smart contract reference**](../smart-contracts/overview.md)

### How Policy Enforcement Is Layered

Policy is enforced **twice** by design.

| Level                             | What It Catches                                                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Off-chain** Brain Policy Engine | Most evaluations, fast feedback, dynamic conditions, rich error messages                                                                                                                                                                                                |
| **On-chain** `BrainSmartAccount`  | The session key is bound to the active `policyVersion` at grant time and its scope + spend caps are enforced inside `executeViaSessionKey`. Any action outside the granted key's bounds is rejected at the account level, regardless of what the off-chain engine said. |

{% hint style="success" %}
Belt and braces. Even if the off-chain engine were compromised, the on-chain account would still reject any call outside the granted session key's policyVersion-bound scope and spend caps.
{% endhint %}

Each session key is bound to the active `policyVersion` at grant time, and every `executeViaSessionKey` call carries a single-use replay nonce, so a call cannot be replayed against a different action.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🤖 Agents</strong></td><td>How agents propose actions and receive scope grants.</td><td><a href="agents.md">agents.md</a></td><td></td></tr><tr><td><strong>📜 Audit and Proof</strong></td><td>How every policy decision is captured.</td><td><a href="audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr><tr><td><strong>📜 BrainPolicyRegistry</strong></td><td>The on-chain anchor.</td><td><a href="../smart-contracts/brainpolicyregistry.md">brainpolicyregistry.md</a></td><td></td></tr></tbody></table>
