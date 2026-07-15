# Payment Intents

A **PaymentIntent** is an agent-proposed financial action that lives as a row in the Ledger. It is the only path to financial execution in Brain. There is no shortcut.

| Property             | Value                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Layer**            | Ledger row, lifecycle owned by Agent layer                                                             |
| **Created by**       | Internal or external agents                                                                            |
| **Executes through** | Provider rails (ACH via Plaid Transfer, NetSuite SuiteTalk, BrainSmartAccount on-chain)                |
| **Gates**            | Policy decision plus the pre-execution gate (13 numbered checks + 10 hardening additions = 23 entries) |

{% hint style="info" %}
PaymentIntents are the **second of two controlled write paths** into the Ledger. The first is Raw extraction. PaymentIntents are the only Ledger write that doesn't originate from a Raw artifact, by design.
{% endhint %}

### Why PaymentIntents Are a Ledger Entity

A proposed payment is itself a financial fact. Treating it as a row in the Ledger has three consequences:

| Property                         | Effect                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Queryable like any other row** | The Wiki, Policy, and other agents can read PaymentIntents the same way they read transactions or obligations |
| **Provenance carries through**   | Every state transition becomes an audit event linked to the row                                               |
| **Policy reads it directly**     | Policy evaluators read PaymentIntent fields and the live Ledger together; no shadow data model                |

### The `ledger_payment_intents` Row

```sql
ledger_payment_intents (
  id,
  owner_id,
  created_by_agent_id,
  action_type,            -- ach_outbound | ach_inbound | wire | onchain_transfer | erp_writeback | card_payment | x402_settle | escrow_release | other
  source_account_id,
  destination_counterparty_id,
  amount,
  currency,
  obligation_id,          -- optional
  invoice_id,             -- optional
  status,                 -- proposed | pending_approval | approved | rejected | executed | failed | cancelled
  policy_decision_id,
  approval_ids[],
  execution_receipt_ids[],
  evidence_ids[],
  created_at,
  updated_at
)
```

### Lifecycle

```
proposed
  │
  │ Policy evaluates against live Ledger state
  │
  ├──► auto-allow ─────► approved
  │
  ├──► confirm ────────► pending_approval
  │                       │
  │                       │ approver(s) sign EIP-712
  │                       │
  │                       └──► approved
  │
  └──► reject ─────────► rejected

approved
  │
  │ 13 numbered checks (+10 hardening additions)
  │
  ├──► gate passes ────► dispatching
  │                       │
  │                       ├──► success ────► executed
  │                       │
  │                       └──► rail failure ► failed
  │
  └──► gate fails ─────► aborts before outbox handoff
```

[**→ The Pre-Execution Gate**](the-pre-execution-gate.md)

### Rails

A gate-passed intent is handed to a durable outbox in the same database
transaction that moves the intent from `approved` to `dispatching`. For
ledger-account payments, that transaction also locks the source account, locks
the latest balance snapshot, rechecks available balance net of active
reservations, creates a balance reservation, and stores its `reservation_id` on
the outbox row. The outbox worker later consumes the reservation when the intent
reaches `executed`, or releases it when a deterministic rail rejection moves the
intent to `failed`.

Two rails are real:

| Rail           | Implementation                           | Settlement                                                                                                        |
| -------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bank_ach`     | Plaid Transfer (authorization → create)  | **Async**. `dispatch` returns `pending`; a Plaid `TRANSFER_EVENTS_UPDATE` webhook settles or fails the outbox row |
| `onchain_base` | `BrainSmartAccount.executeViaSessionKey` | On-chain receipt; the rail threads the per-holder session-key nonce and signs via Azure Key Vault                 |

Both are idempotency-keyed by the outbox row so a crash-retry never moves money twice. `erp_writeback` (NetSuite) remains a fail-closed stub. The M2M settlement action types `x402_settle` / `escrow_release` map to the `x402_base` / `escrow_base` rails (USDC on Base / `BrainEscrow`). They do not create ledger balance reservations because their spend is enforced by the settlement wallet or locked escrow state rather than by an off-chain ledger account hold. The live SDK wiring (Plaid / viem+KMS) and the sandbox/anvil round-trips are a follow-up; see `services/execution/README.md`.

For on-chain money movement, policy `allow` is not always enough to dispatch.
`onchain_transfer` and `escrow_release` require at least one recorded human
approval before execution. `x402_settle` may stay autonomous only when the signed
policy rule permits on-chain settlement and sets an `x402_autonomous_max_amount`
cap that covers the amount.

### State Transitions

| From               | To                 | Trigger                                                                  |
| ------------------ | ------------------ | ------------------------------------------------------------------------ |
| `proposed`         | `pending_approval` | Policy returned `confirm`; approvers required                            |
| `proposed`         | `approved`         | Policy returned `auto`; no human in the loop                             |
| `proposed`         | `rejected`         | Policy returned `reject`                                                 |
| `pending_approval` | `approved`         | All required approvers signed                                            |
| `pending_approval` | `rejected`         | Approver explicitly rejected                                             |
| `pending_approval` | `cancelled`        | Tenant cancelled before approval                                         |
| `approved`         | `dispatching`      | Gate passed; outbox row and any balance reservation committed atomically |
| `approved`         | `paused`           | Tenant or halt-category kill-switch paused execution                     |
| `paused`           | `approved`         | Resume re-ran and passed the live gate                                   |
| `dispatching`      | `executed`         | Outbox worker received and validated a successful rail receipt           |
| `dispatching`      | `failed`           | Deterministic rail rejection where the worker can prove no money moved   |

Every transition emits an audit event. The full history of any PaymentIntent is reconstructable from `audit_events` ordered by `created_at`.

### How Agents Create Them

Internal agents call `PaymentIntentService.create()`. External agents call the MCP `payment_intent.propose` tool. **Both paths go through the same service method**, so policy evaluation, validation, and audit emission are identical.

```typescript
// Internal agent (TypeScript)
const intent = await paymentIntentService.create({
  ownerId: "acme",
  createdByAgentId: "ag_payment_v1",
  actionType: "ach_outbound",
  sourceAccountId: "acct_ops",
  destinationCounterpartyId: "cp_aws",
  amount: "61404.12",
  currency: "USD",
  obligationId: "ob_aws_2025_09",
  idempotencyKey: "pi_2025_09_aws_001",
});

console.log(intent.status); // "proposed" → resolved by Policy
console.log(intent.policyDecisionId); // the PolicyDecision row to inspect
```

### API Surface

PaymentIntents are a Ledger entity but their lifecycle endpoints live in the Agent group.

| Method | Endpoint                           | Purpose                                          |
| ------ | ---------------------------------- | ------------------------------------------------ |
| `POST` | `/v1/payment-intents`              | Agent proposes; returns `proposed` PaymentIntent |
| `GET`  | `/v1/payment-intents/{id}`         | Detail with PolicyDecision and audit trail       |
| `POST` | `/v1/payment-intents/{id}/approve` | Human approval for `confirm` intents             |
| `POST` | `/v1/payment-intents/{id}/reject`  | Reject                                           |
| `POST` | `/v1/payment-intents/{id}/execute` | Execute approved intent through rail             |

The MCP equivalent: `payment_intent.propose` for creation. **There is no `payment_intent.execute` on MCP**. Execution is reserved for internal Brain workers running under tenant policy.

### Reading Them Like Any Other Ledger Row

Because PaymentIntents are a real Ledger entity, the Wiki and other agents query them the same way they query transactions or obligations.

```http
GET /v1/ledger/payment-intents?status=pending_approval&owner=acme
```

Or in the MCP:

```json
{ "method": "resources/read", "params": { "uri": "brain://ledger/payment-intents/pi_a1b2c3" } }
```

A Wiki page about a vendor automatically includes their pending PaymentIntents in the **Recent Activity** section.

### Idempotency

Every PaymentIntent creation requires an `idempotencyKey`. Brain stores it in a per-tenant index; retries with the same key return the existing PaymentIntent. This protects against double-proposal under network errors or agent retries. A second, proposal-layer key dedups equivalent proposals from the same agent run (collision → `409 agent_proposal_duplicate`).

### Kill-Switch: The `paused` State

An `approved` PaymentIntent can be **paused** without a terminal transition: `approved ⇄ paused`, and `paused → cancelled`. `POST /v1/payment-intents/{id}/pause` holds it; `/resume` re-runs the **live** §6 gate before re-entering `approved` (defending against Ledger state drift while paused). `POST /v1/agents/{agent_id}/halt` atomically pauses all of an agent's in-flight intents and quarantines the agent. The rail dispatcher re-reads state immediately before submission and aborts cleanly if the intent was paused.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🚪 Pre-execution Gate</strong></td><td>The deterministic gate every payment must pass (13 numbered checks + 4 hardening additions).</td><td><a href="the-pre-execution-gate.md">the-pre-execution-gate.md</a></td><td></td></tr><tr><td><strong>🤖 Agents</strong></td><td>How internal and external agents propose actions.</td><td><a href="agents.md">agents.md</a></td><td></td></tr><tr><td><strong>📋 Policy and Permissioning</strong></td><td>How Policy evaluates PaymentIntents.</td><td><a href="policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr></tbody></table>
