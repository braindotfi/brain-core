---
description: The rules a tenant signed. How decisions are made.
---

# Policy

Every action that touches a tenant's money runs through Policy. Policy is the rules a tenant has signed, expressed in plain English, compiled to deterministic checks, and evaluated on every proposed action.

### Three Possible Outcomes

| Outcome          | Meaning                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `auto`           | The action satisfies policy and may proceed only if the rail's hard floor also permits autonomy |
| `needs_approval` | The action is allowed but requires a human signature first                                      |
| `rejected`       | The action is not allowed; structured reason returned                                           |

There is no fourth outcome. There is no override. There is no bypass.

Policy `auto` is not the same as "money moves immediately" for every rail. A policy allow on `onchain_transfer`, `escrow_release`, or `wire` still requires a recorded human approval before dispatch. `x402_settle` can run autonomously only when the matched signed policy rule sets both `onchain_settlement_permitted: true` and a covering `x402_autonomous_max_amount`. ACH and card can run autonomously only when the matched signed policy rule carries a covering `ach_autonomous_max_amount` or `card_autonomous_max_amount`. Missing, malformed, wrong-currency, or over-cap values fail closed to human approval.

### Plain-English in, Deterministic Out

A tenant writes:

> Allow invoice payments under $5,000 to approved vendors. Require CFO approval above $5,000. Block payments to new counterparties without review.

Brain compiles to:

```json
[
  { "if": "amount < 5000 and counterparty.known", "then": "auto" },
  {
    "if": "amount >= 5000 and counterparty.known",
    "then": "needs_approval",
    "approvers": ["role:cfo"]
  },
  { "if": "!counterparty.known", "then": "rejected", "reason": "new_counterparty_review_required" }
]
```

The tenant signs the **compiled** form. The compiler also returns a human-readable explanation so the tenant can verify the rules match their intent before signing.

### Versioning

Policies are versioned. A new version supersedes the old one. Past actions remain bound to whichever version evaluated them, which means the audit log is reproducible: anyone can replay any past decision against the policy that was active at the time.

### Where the Rules Live

Two layers, by design:

| Layer                            | Catches                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ |
| **Off-chain Policy engine**      | Most violations, fast feedback, dynamic conditions                       |
| **On-chain `BrainSmartAccount`** | Anything the off-chain layer missed; protects against backend compromise |

The on-chain layer is the belt and braces. Even if Brain's backend were fully compromised, an attacker still couldn't push through a payment that doesn't carry a valid, non-expired, scope-bound policy verdict.

[**→ Smart contracts: BrainSmartAccount**](../smart-contracts/brainsmartaccount.md)

### The Pre-Execution Gate

After Policy says `auto` (or after a human approves a `needs_approval`), one more check runs before money leaves: a deterministic gate (13 numbered checks + 10 hardening additions = 23 entries) that reads the **current** Ledger state. Account balance, counterparty status, idempotency, on-chain limits, obligation direction (payable vs receivable), audit-chain health.

Policy is the standing rule. The gate is the flight check. Both must pass.

[**→ Protocol: The pre-execution gate**](../protocol/the-pre-execution-gate.md)

### Why ESCALATE Is the Default

Any action that doesn't match a rule is **escalated for approval**, not auto-allowed and not silently rejected. This is intentional: new scenarios fail-safe, in front of a human, instead of silently going in either direction.

### What Policy Can Express

| Concept             | Example                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| **Amounts**         | `under $5,000`, `between $1k and $50k`                                         |
| **Counterparties**  | `approved vendors`, `new counterparties`, `to employees`, `to tax authorities` |
| **Account state**   | `if balance is at least $50k`                                                  |
| **Time windows**    | `weekdays 9am-5pm Pacific`                                                     |
| **Approvals**       | `require approval from CFO and CEO`                                            |
| **Outright denial** | `block`, `do not allow`                                                        |

For edge cases that don't fit plain English, you can author rules directly in the structured grammar.

### Privacy

Only the policy hash goes on-chain. The text and compiled rules stay encrypted in the tenant's partition. Counterparties verifying a policy decision check that the hash referenced in the verdict matches a hash registered on-chain. They don't need (and don't get) the rules themselves.

### Related

| Concept                            | Page             |
| ---------------------------------- | ---------------- |
| What Policy reads                  | Memory           |
| Who is subject to Policy           | Agents           |
| The audit record of every decision | Proof            |
| Deep dive                          | Protocol: Policy |
