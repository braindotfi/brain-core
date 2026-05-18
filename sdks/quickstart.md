# Quickstart

Build a policy-gated agent action in five minutes. By the end, an agent will have proposed an action, the policy engine will have evaluated it, and an audit event will be queryable on Base.

### Prerequisites

| Requirement     | Why                                                            |
| --------------- | -------------------------------------------------------------- |
| Node.js 18+     | SDK runtime                                                    |
| A Brain API key | Get one from the [Developer Console](https://console.brain.fi) |
| A test tenant   | Created via the Console or `POST /v1/tenants`                  |

{% hint style="info" %}
Start in the **sandbox** environment. It uses Base Sepolia testnet, so there is no real money at stake while you are learning.
{% endhint %}

### Step 1: Install

```bash
npm install @brain/sdk
```

### Step 2: Initialise

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({
  apiKey: process.env.BRAIN_KEY,
  environment: "sandbox",
});
```

### Step 3: Connect a Source

```typescript
const source = await brain.sources.connect({
  tenantId: "acme",
  type: "plaid",
  credentials: { /* Plaid Link token */ },
});

// Source ingestion runs in the background.
// You can check status:
const status = await brain.sources.get(source.id);
console.log(status.last_synced_at);
```

### Step 4: Ask a Wiki Question

```typescript
const answer = await brain.wiki.question({
  tenantId: "acme",
  question: "What did we spend on AWS last quarter, by environment?",
});

console.log(answer.text);
console.log(answer.citations);     // every claim is cited
console.log(answer.audit_event_id); // logged event ID
```

### Step 5: Register a Policy

```typescript
const policy = await brain.policy.create({
  tenantId: "acme",
  text: `
    Allow invoice payments under $5,000 to approved vendors,
    require approval above $5,000,
    and block payments to new counterparties without review.
  `,
});

console.log(policy.compiled);    // deterministic JSON
console.log(policy.explanation); // human-readable summary

// Sign and anchor (EIP-712)
await brain.policy.sign(policy.id, { signer: yourSigner });
```

### Step 6: Register an agent

```typescript
const agent = await brain.agents.register({
  tenantId: "acme",
  agentAddress: "0xagent...",
  capabilities: ["pay_invoice"],
  mcpEndpoint: "https://my-agent.example.com/mcp",
});

await brain.agents.grantScope({
  tenantId: "acme",
  agentAddress: agent.address,
  capability: "pay_invoice",
  maxAmount: "10000",       // in smallest unit
  signer: yourSigner,        // EIP-712 ScopeAttestation
});
```

### Step 7: Propose an Action

```typescript
const proposal = await brain.agents.propose({
  tenantId: "acme",
  agentId:  agent.id,
  action:   { type: "pay_invoice", invoiceId: "inv_8231" },
});

console.log(proposal.decision);    // "ALLOW" | "ESCALATE" | "DENY"
console.log(proposal.reason);      // structured reason if not ALLOW
console.log(proposal.policy_version);

if (proposal.decision === "ALLOW") {
  await brain.actions.execute(proposal.actionId);
} else if (proposal.decision === "ESCALATE") {
  // Surface to the named approvers; on approval, call execute().
  console.log("Required approvers:", proposal.approvers);
}
```

What just happened:

1. The agent's proposal was checked against the active policy
2. The policy engine produced a verdict (ALLOW / ESCALATE / DENY)
3. An audit event was recorded for the proposal and the verdict
4. If executed, a UserOperation was assembled and submitted via the bundler, validated on-chain by `BrainSmartAccount`, and another audit event was appended

### Step 8: Pull an Audit Proof

```typescript
const proof = await brain.audit.proof(proposal.audit_event_id);

console.log(proof.event);
console.log(proof.merkle_path);
console.log(proof.anchored_root);
console.log(proof.base_tx_hash);
console.log(proof.base_block);
```

A counterparty can now verify this event by checking the Merkle path against `BrainAuditAnchor.rootAt(tenantId, batchIndex)` on Base.

{% hint style="success" %}
You just executed a policy-gated agent action with an end-to-end audit trail anchored on Base. Total time: about five minutes.
{% endhint %}

### Going to Production

Before deploying to production:

| Checklist Item                               | Why                                                         |
| -------------------------------------------- | ----------------------------------------------------------- |
| Switch `environment` to `"production"`       | Use mainnet, not testnet                                    |
| Use a production API key                     | Sandbox keys are rate-limited                               |
| Tighten the policy                           | Only what the agent actually needs                          |
| Add webhooks for important events            | Get notified on `action.executed`, `policy.registered`, etc |
| Set up key rotation                          | Rotate API keys regularly                                   |
| Use `brain.policy.simulate` before live runs | Dry-run any new policy version                              |
