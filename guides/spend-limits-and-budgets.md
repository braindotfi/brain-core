---
hidden: true
---

# Spend Limits and Budgets

Brain's policy engine provides granular spend controls from global account budgets to per-agent daily limits, asset restrictions, and per-merchant caps. All limits are enforced at the smart account level, not just in the backend.

## Budget Hierarchy

Budgets are enforced at two levels:

* **Account level** — a global cap that applies across all agents under a BrainAccount
* **Agent level** — per-agent limits that must also satisfy the account-level constraint

An agent can never spend more than the lesser of its own limit and the account's global limit.

## Setting a Daily Spend Limit

```typescript
const policy = new PolicyBuilder()
  .setSpendLimit('500 USDC/day')    // Daily rolling window
  .setSpendLimit('2000 USDC/week')  // Weekly cap (additive constraint)
  .setAssetCap('ETH', '1 ETH/day') // Per-asset cap
  .build();
```

## Per-Merchant Limits

```typescript
const policy = new PolicyBuilder()
  .setMerchantCap('0xMerchantA', '100 USDC/day')
  .setMerchantCap('0xMerchantB', '50 USDC/day')
  .setMerchantBlocklist(['0xUntrustedMerchant'])
  .build();
```

## Checking Remaining Budget

```typescript
const budget = await client.policies.getBudgetStatus(agent.agentId);
console.log(budget);
// {
//   dailyLimit: '500 USDC',
//   spent: '213.50 USDC',
//   remaining: '286.50 USDC',
//   resetsAt: '2025-09-02T00:00:00Z'
// }
```

## Budget Reset Windows

<table><thead><tr><th width="149.9609375">Period</th><th>Reset Behaviour</th></tr></thead><tbody><tr><td><code>day</code></td><td>Resets at 00:00 UTC each day</td></tr><tr><td><code>week</code></td><td>Resets at 00:00 UTC each Monday</td></tr><tr><td><code>month</code></td><td>Resets at 00:00 UTC on the 1st of each month</td></tr></tbody></table>

## Approval Thresholds for Large Transactions

For actions above a certain value, you can require multi-party approval:

```typescript
const policy = new PolicyBuilder()
  .setSpendLimit('10000 USDC/day')
  .setApprovalThreshold('1-of-1')            // Standard: policy engine only
  .setHighValueThreshold('5000 USDC',        // Above this amount...
    { approvalThreshold: '2-of-3' })         // ...require multi-sig
  .build();
```

## On-Chain Enforcement

{% hint style="warning" %}
Spend limits are enforced at the `BrainAccount` smart contract level inside `validateUserOp`. Even if the backend policy engine were unavailable or compromised, the smart account would reject any UserOperation that exceeds configured limits.
{% endhint %}

Limits are not advisory. They are hard constraints enforced on-chain before any funds can move.
