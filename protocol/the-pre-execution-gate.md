# The Pre-Execution Gate

Before any PaymentIntent can execute, it must pass a **deterministic 16-step pre-execution gate**. The gate is the only path to financial execution. The gate is non-overridable.

| Property       | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| **Runs at**    | The boundary between `approved` and `executed`               |
| **Reads from** | The live Ledger (current balance, counterparty status, etc.) |
| **Emits**      | An audit event before each step and after each pass/fail     |

### Why a Gate

Policy returns `allow` based on the rules a tenant signed. But "the rules say yes" is not the same as "it is safe to execute right now." Between Policy `allow` and rail dispatch, dozens of conditions can change: a balance drops below the threshold, a counterparty flips to sanctioned, the policy version supersedes, an idempotency-key replay arrives.

The gate is the deterministic check that runs immediately before dispatch and reads from the **current** Ledger state, not the snapshot Policy evaluated against.

{% hint style="success" %}
Think of Policy as the **standing rule** and the gate as the **flight check**. Both must pass. Either one failing is a hard stop.
{% endhint %}

### The Core Steps

The gate runs the following classes of check, every payment, every time. Steps are deterministic and versioned with the protocol. (v0.4 inserts three further checks at their correct positions — see **v0.4 Additions** below — for a total of 16.)

| #   | Step                                                                                           | Reads From                              |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | PaymentIntent exists and is in `approved` status                                               | `ledger_payment_intents`                |
| 2   | PolicyDecision exists, matches the intent, and was for the active policy version               | `policy_decisions`                      |
| 3   | Idempotency key has not already produced an execution receipt                                  | `executions`                            |
| 4   | Source account is active and not frozen                                                        | `ledger_accounts`                       |
| 5   | Source account current balance ≥ amount (with currency match)                                  | `ledger_accounts.current_balance`       |
| 6   | Destination counterparty is verified or fits a Policy-allowed pattern                          | `ledger_counterparties.verified_status` |
| 7   | Destination counterparty is not sanctioned                                                     | `ledger_counterparties.risk_level`      |
| 8   | Required approver signatures are present, valid, and signed against the same PolicyDecision id | `approvals`                             |
| 9   | Active policy hash matches the policy hash anchored on-chain (where applicable)                | `BrainPolicyRegistry`                   |
| 10  | For on-chain rails: session key validity window covers the call moment                         | `BrainSmartAccount.SessionKey`          |
| 11  | For on-chain rails: rail-specific limits (per-tx, per-period) not exceeded                     | `BrainSmartAccount.SessionKey`          |
| 12  | No conflicting in-flight execution for the same source account within the configured cooldown  | `executions`                            |
| 13  | Audit chain is healthy (latest anchor not stale beyond threshold)                              | `audit_anchors`                         |

If **any** step fails, the PaymentIntent transitions to `failed` with a structured reason. No rail call is made.

### v0.4 Additions

Three further deterministic checks were added in v0.4, each inserted at its correct position in the sequence, bringing the total to **16**:

| Check                             | What It Enforces                                                                                                            | Reads From                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Ledger-state snapshot binding** | The Ledger snapshot Policy decided against is captured and re-validated immediately before dispatch; drift is a hard reject | `computeLedgerSnapshot` over Ledger |
| **Evidence semantic validation**  | The supporting evidence actually substantiates _this_ action (amount, counterparty, obligation), not just that it exists    | `raw_parsed`, `evidence_ids`        |
| **Duplicate-payment protection**  | No prior execution with the same counterparty + amount inside the configured window                                         | `executions`                        |

These persist into the `gate_checks` snapshot on the audit-before event, so the full 16-check trace is part of the verifiable Proof artifact.

### Audit Emission

The gate emits two audit events per step.

| Event                                | When                                          |
| ------------------------------------ | --------------------------------------------- |
| `payment_intent.gate.step_started`   | Immediately before each step runs             |
| `payment_intent.gate.step_completed` | After the step passes (or fails, with reason) |

Plus two outer events:

| Event                                                        | When                                         |
| ------------------------------------------------------------ | -------------------------------------------- |
| `payment_intent.gate.started`                                | Before step 1                                |
| `payment_intent.gate.passed` or `payment_intent.gate.failed` | After the final step (or earlier on failure) |

The full step-by-step audit means a counterparty or auditor can reconstruct exactly what was checked, in what order, against what state.

### Why Deterministic

Every step is a pure function over Ledger state plus the PaymentIntent. Two independent runs against the same Ledger snapshot produce the same result. This is what lets the gate appear in the audit trail with high confidence: it is replayable.

| Anti-pattern                                                     | Forbidden Because                              |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| LLM-driven decision in the gate                                  | Non-deterministic; not replayable              |
| Network call to an external service for a "yes/no"               | Adds non-determinism and latency to a hot path |
| Step that mutates Ledger state                                   | The gate must be observation-only              |
| Step that depends on wall-clock except for stale-data thresholds | Wall-clock dependence is opt-in and bounded    |

### What Happens on Failure

Failure is structured.

```json
{
  "payment_intent_id": "pi_a1b2c3",
  "status": "failed",
  "gate_failure": {
    "step": 5,
    "reason": "INSUFFICIENT_BALANCE",
    "expected_min": "61404.12 USD",
    "observed": "58901.04 USD",
    "ledger_row": "acct_ops"
  },
  "audit_event_id": "evt_..."
}
```

The agent that proposed the intent receives the failure code. It can re-propose with adjusted parameters (smaller amount, different source account); that's a new PaymentIntent, with a new id, new PolicyDecision, and a fresh gate run.

### Why No Override

A bypass path defeats the purpose. If anyone (tenant, operator, agent) can override the gate, then the audit story collapses ("the gate passed, except when it didn't"). The gate is **non-overridable** by design. To execute a payment that the gate currently rejects, the tenant must change the underlying state (top up the account, verify the counterparty, sign a new policy). The gate then passes naturally.

This is the same logic as airline pre-flight checklists: not because the captain doesn't know what they're doing, but because removing the checklist removes the proof that it was done.

### Dry-Run Mode (Agent Autonomy)

The gate accepts a `dryRun` flag. In dry-run it runs the **same** 16 checks against the **same** Ledger state and returns the same envelope, but does **not** insert a `policy_decisions` row, write a reservation, or emit audit events. Agents call dry-run before building a full proposal — to short-circuit obvious rejects and to decide `confirm` vs `execute`. There is **one** evaluator: the same gate code runs live and dry-run, so the two can never drift. The live gate still runs at execute time.

### Behavior Pinning Check

A new check sits between identity and authorization: the runtime agent `behaviorHash` must equal the value registered on-chain in `BrainMCPAgentRegistry`. A mismatch (a silent model/prompt/tool swap) is a hard reject regardless of every other signal. It is verified only when a runtime hash is supplied, so the canonical happy path remains the 16 checks.

### Net of Reservations

Check #8 (balance) now subtracts active balance reservations: `available_balance − Σ(active reservations) ≥ amount`. With several money-movers live, parallel proposers can't double-spend the same balance.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>💸 Payment Intents</strong></td><td>The Ledger entity the gate evaluates.</td><td><a href="payment-intents.md">payment-intents.md</a></td><td></td></tr><tr><td><strong>📋 Policy and Permissioning</strong></td><td>The standing rule that runs alongside the flight check.</td><td><a href="policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>🛡️ Audit and Proof</strong></td><td>Where the per-step audit events land.</td><td><a href="audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr></tbody></table>
