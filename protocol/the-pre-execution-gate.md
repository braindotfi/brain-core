# The Pre-Execution Gate

Before any PaymentIntent can execute, it must pass a **deterministic 13-step pre-execution gate**. The gate is the only path to financial execution. There is no shortcut, no override, no bypass.

| Property       | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| **Runs at**    | The boundary between `approved` and `executed`               |
| **Reads from** | The live Ledger (current balance, counterparty status, etc.) |
| **Emits**      | An audit event before each step and after each pass/fail     |

### Why a gate

Policy returns `allow` based on the rules a tenant signed. But "the rules say yes" is not the same as "it is safe to execute right now." Between Policy `allow` and rail dispatch, dozens of conditions can change: a balance drops below the threshold, a counterparty flips to sanctioned, the policy version supersedes, an idempotency-key replay arrives.

The gate is the deterministic check that runs immediately before dispatch and reads from the **current** Ledger state, not the snapshot Policy evaluated against.

{% hint style="success" %}
Think of Policy as the **standing rule** and the gate as the **flight check**. Both must pass. Either one failing is a hard stop.
{% endhint %}

### The 13 steps

The gate runs the following classes of check, every payment, every time. Steps are deterministic and versioned with the protocol.

| #  | Step                                                                                           | Reads From                              |
| -- | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1  | PaymentIntent exists and is in `approved` status                                               | `ledger_payment_intents`                |
| 2  | PolicyDecision exists, matches the intent, and was for the active policy version               | `policy_decisions`                      |
| 3  | Idempotency key has not already produced an execution receipt                                  | `executions`                            |
| 4  | Source account is active and not frozen                                                        | `ledger_accounts`                       |
| 5  | Source account current balance ≥ amount (with currency match)                                  | `ledger_accounts.current_balance`       |
| 6  | Destination counterparty is verified or fits a Policy-allowed pattern                          | `ledger_counterparties.verified_status` |
| 7  | Destination counterparty is not sanctioned                                                     | `ledger_counterparties.risk_level`      |
| 8  | Required approver signatures are present, valid, and signed against the same PolicyDecision id | `approvals`                             |
| 9  | Active policy hash matches the policy hash anchored on-chain (where applicable)                | `BrainPolicyRegistry`                   |
| 10 | For on-chain rails: session key validity window covers the call moment                         | `BrainSmartAccount.SessionKey`          |
| 11 | For on-chain rails: rail-specific limits (per-tx, per-period) not exceeded                     | `BrainSmartAccount.SessionKey`          |
| 12 | No conflicting in-flight execution for the same source account within the configured cooldown  | `executions`                            |
| 13 | Audit chain is healthy (latest anchor not stale beyond threshold)                              | `audit_anchors`                         |

If **any** step fails, the PaymentIntent transitions to `failed` with a structured reason. No rail call is made.

### Audit emission

The gate emits two audit events per step.

| Event                                | When                                          |
| ------------------------------------ | --------------------------------------------- |
| `payment_intent.gate.step_started`   | Immediately before each step runs             |
| `payment_intent.gate.step_completed` | After the step passes (or fails, with reason) |

Plus two outer events:

| Event                                                        | When                                  |
| ------------------------------------------------------------ | ------------------------------------- |
| `payment_intent.gate.started`                                | Before step 1                         |
| `payment_intent.gate.passed` or `payment_intent.gate.failed` | After step 13 (or earlier on failure) |

The full step-by-step audit means a counterparty or auditor can reconstruct exactly what was checked, in what order, against what state.

### Why deterministic

Every step is a pure function over Ledger state plus the PaymentIntent. Two independent runs against the same Ledger snapshot produce the same result. This is what lets the gate appear in the audit trail with high confidence: it is replayable.

| Anti-pattern                                                     | Forbidden Because                              |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| LLM-driven decision in the gate                                  | Non-deterministic; not replayable              |
| Network call to an external service for a "yes/no"               | Adds non-determinism and latency to a hot path |
| Step that mutates Ledger state                                   | The gate must be observation-only              |
| Step that depends on wall-clock except for stale-data thresholds | Wall-clock dependence is opt-in and bounded    |

### What happens on failure

Failure is structured.

```json
{
  "payment_intent_id": "pi_a1b2c3",
  "status": "failed",
  "gate_failure": {
    "step": 5,
    "reason": "INSUFFICIENT_BALANCE",
    "expected_min": "61404.12 USD",
    "observed":     "58901.04 USD",
    "ledger_row":   "acct_ops"
  },
  "audit_event_id": "evt_..."
}
```

The agent that proposed the intent receives the failure code. It can re-propose with adjusted parameters (smaller amount, different source account); that's a new PaymentIntent, with a new id, new PolicyDecision, and a fresh gate run.

### Why no override

A bypass path defeats the purpose. If anyone (tenant, operator, agent) can override the gate, then the audit story collapses ("the gate passed, except when it didn't"). The gate is **non-overridable** by design. To execute a payment that the gate currently rejects, the tenant must change the underlying state (top up the account, verify the counterparty, sign a new policy). The gate then passes naturally.

This is the same logic as airline pre-flight checklists: not because the captain doesn't know what they're doing, but because removing the checklist removes the proof that it was done.

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>💸 Payment Intents</strong></td><td>The Ledger entity the gate evaluates.</td><td><a href="payment-intents.md">payment-intents.md</a></td><td></td></tr><tr><td><strong>📋 Policy and Permissioning</strong></td><td>The standing rule that runs alongside the flight check.</td><td><a href="policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>🛡️ Audit and Proof</strong></td><td>Where the per-step audit events land.</td><td><a href="audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr></tbody></table>
