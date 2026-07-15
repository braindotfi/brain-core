# The Pre-Execution Gate

Before any PaymentIntent can execute, it must pass a **deterministic pre-execution gate**: **13 numbered checks plus 10 hardening additions (checks 1.5, 3.5, 5.5, 6.5, 6.6, 6.7, 7.5, 8.5, 9.5, 11.5) = 23 entries total**; the canonical happy path is the 13 numbered checks (several additions record `not_applicable` for non-M2M flows). The gate is the only path to financial execution. The gate is non-overridable.

| Property       | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| **Runs at**    | The boundary before `approved -> dispatching`                |
| **Reads from** | The live Ledger (current balance, counterparty status, etc.) |
| **Emits**      | An audit event before each step and after each pass/fail     |

### Why a Gate

Policy returns `allow` based on the rules a tenant signed. But "the rules say yes" is not the same as "it is safe to execute right now." Between Policy `allow` and rail dispatch, dozens of conditions can change: a balance drops below the threshold, a counterparty flips to sanctioned, the policy version supersedes, an idempotency-key replay arrives.

The gate is the deterministic check that runs immediately before dispatch and reads from the **current** Ledger state, not the snapshot Policy evaluated against.

{% hint style="success" %}
Think of Policy as the **standing rule** and the gate as the **flight check**. Both must pass. Either one failing is a hard stop.
{% endhint %}

### The Core Steps

The gate runs the following classes of check, every payment, every time. Steps are deterministic and versioned with the protocol. These are the 13 numbered checks of the canonical happy path; 10 hardening additions are inserted at their correct positions (checks 1.5, 3.5, 5.5, 6.5, 6.6, 6.7, 7.5, 8.5, 9.5, 11.5. See **Hardening Additions** below) for 23 entries total. The M2M / x402 / escrow additions (3.5, 5.5, 6.5, 6.6, 8.5) record `not_applicable` for non-M2M flows so the canonical happy path is unchanged. Check 6.7 (obligation direction) is dormant when the intent carries no `obligation_id`.

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

### Hardening Additions

Five further deterministic checks were added as hardening, each inserted at its correct position in the sequence (checks 1.5, 6.7, 7.5, 9.5, 11.5), bringing the non-M2M total to **18 entries**:

| Check                                       | What It Enforces                                                                                                                                                                    | Reads From                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Agent behavior pinned** (1.5)             | The runtime agent `behaviorHash` equals the value registered on-chain; a silent model/prompt/tool swap is a hard reject                                                             | `BrainMCPAgentRegistry`             |
| **Obligation direction matches flow** (6.7) | When the intent cites an `obligation_id`, the linked obligation is NOT a receivable. An outflow targeting an obligation owed TO us (e.g. a prompt-injected refund) is a hard reject | `ledger_obligations.direction`      |
| **Ledger-state snapshot binding** (7.5)     | The Ledger snapshot Policy decided against is captured and re-validated immediately before dispatch; drift is a hard reject                                                         | `computeLedgerSnapshot` over Ledger |
| **Evidence semantic validation** (9.5)      | The supporting evidence actually substantiates _this_ action (amount, counterparty, obligation), not just that it exists                                                            | `raw_parsed`, `evidence_ids`        |
| **Duplicate-payment protection** (11.5)     | No prior execution with the same counterparty + amount inside the configured window                                                                                                 | `executions`                        |

These persist into the `gate_checks` snapshot on the audit-before event, so the full 18-entry trace is part of the verifiable Proof artifact.

### M2M / x402 settlement checks (dormant until wired)

For agent-to-agent settlement (x402 USDC-on-Base and `BrainEscrow` releases), RFC 0001 adds five further deterministic checks at positions 3.5, 5.5, 6.5, 6.6, 8.5. Each is **dormant-until-wired**: it adds a row only when the PaymentIntent carries the relevant settlement/escrow context **and** its (deferred) on-chain loader is configured. Otherwise it records nothing and the canonical 13 + 5 path is unchanged. None is a money path of its own; each only tightens an already-gated settlement.

| Check                                    | What It Enforces                                                                                                                                            | Reads From                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **On-chain-settlement permitted** (3.5)  | The payment class is allowed to settle on-chain for this tenant (else it must route off-chain)                                                              | policy dimension                  |
| **Agent-counterparty attested** (5.5)    | When the payee is an agent, it is registered + active in `BrainMCPAgentRegistry`                                                                            | `BrainMCPAgentRegistry`           |
| **x402 payment-context valid** (6.5)     | The x402 `paymentRequirements` (amount, asset = USDC, network = Base, recipient) match the intent                                                           | intent settlement context         |
| **Escrow-state bound** (6.6)             | For an escrow release, the on-chain `BrainEscrow` lock matches: still `Locked`, enough **remaining** to cover this release, same payee, same `jobTermsHash` | `BrainEscrow.getEscrow` (testnet) |
| **Micropayment cap within window** (8.5) | Per-agent rolling-window spend stays within the policy envelope (mirrors the on-chain session-key window cap)                                               | `executions`                      |

The on-chain readers for 3.5 / 5.5 / 6.6 / 8.5 are deferred live-wiring; until they are configured those checks stay dormant, so the gate is unchanged for non-settlement payments.

Check 11 also enforces the hard human-approval floor for on-chain money
movement. `onchain_transfer` and `escrow_release` require at least one recorded
human approval even when policy returns `allow`. `x402_settle` can remain
approval-free only when the matched signed policy rule sets
`onchain_settlement_permitted: true` and `x402_autonomous_max_amount` with the
same currency and a value greater than or equal to the intent amount. Otherwise
the gate fails with `hard_human_approval_floor_required` until a human approval
is recorded.

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

The gate accepts a `dryRun` flag. In dry-run it runs the **same** checks against the **same** Ledger state and returns the same envelope, but does **not** insert a `policy_decisions` row, write a reservation, or emit audit events. Agents call dry-run before building a full proposal. To short-circuit obvious rejects and to decide `confirm` vs `execute`. There is **one** evaluator: the same gate code runs live and dry-run, so the two can never drift. The live gate still runs at execute time.

### Behavior Pinning Check

Check 1.5 sits between identity and authorization: the runtime agent `behaviorHash` must equal the value registered on-chain in `BrainMCPAgentRegistry`. A mismatch (a silent model/prompt/tool swap) is a hard reject regardless of every other signal. It is verified only when a runtime hash is supplied (or when a tenant opts into mandatory pinning), so the canonical happy path remains the 13 numbered checks.

### Net of Reservations

Check #8 (balance) subtracts active balance reservations:
`available_balance - Σ(active reservations) ≥ amount`. With several
money-movers live, parallel proposers cannot double-spend the same balance.

The live execution path treats the gate as a preflight and then performs the
authoritative reserve in the handoff transaction. It locks the source account,
locks the latest balance snapshot, rechecks `available_balance - active
reservations >= amount`, creates the reservation, moves a PaymentIntent from
`approved` to `dispatching`, and enqueues the outbox row. The outbox row carries
`reservation_id` across the async boundary. On a successful rail receipt,
`completeExecution()` consumes the reservation inside the same transaction as
`dispatching -> executed`; on a deterministic rail rejection, `failExecution()`
releases it inside the same transaction as `dispatching -> failed`.
`x402_settle` and `escrow_release` remain `not_applicable` for this check because
their spend is enforced by on-chain
wallet or escrow state, not by an off-chain ledger-account hold.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>💸 Payment Intents</strong></td><td>The Ledger entity the gate evaluates.</td><td><a href="payment-intents.md">payment-intents.md</a></td><td></td></tr><tr><td><strong>📋 Policy and Permissioning</strong></td><td>The standing rule that runs alongside the flight check.</td><td><a href="policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>🛡️ Audit and Proof</strong></td><td>Where the per-step audit events land.</td><td><a href="audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr></tbody></table>
