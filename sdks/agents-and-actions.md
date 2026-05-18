# Agents and Actions

The `brain.agents` and `brain.actions` namespaces cover the full agent lifecycle: registration, scope grants, proposing actions, approval, and execution.

### Register an Agent

```typescript
const agent = await brain.agents.register({
  tenantId: "acme",
  agentAddress: "0xagent...",
  capabilities: ["pay_invoice", "rebalance_treasury"],
  mcpEndpoint: "https://my-agent.example.com/mcp",
  metadataUri: "ipfs://Qm...",
});

agent.id;
agent.address;
agent.identity_root;     // ERC-8004 identity root
agent.reputation_root;   // current reputation Merkle root
```

### Grant Scope to an Agent

A scope grant is a tenant-signed authorisation. Without it, the agent has no permission to act for the tenant.

```typescript
import { signScopeAttestation } from "@brain/sdk";

const sig = await signScopeAttestation({
  tenantId:      "acme",
  agentAddress:  agent.address,
  capability:    "pay_invoice",
  maxAmount:     "10000_000000",   // 10,000 USDC, 6 decimals
  resourceScope: "0x...",          // counterparty allowlist root
  notBefore:     0,
  notAfter:      Math.floor(Date.now() / 1000) + 86400 * 30,
  nonce:         0,
  signer:        yourSigner,
});

await brain.agents.grantScope({
  tenantId:      "acme",
  agentAddress:  agent.address,
  capability:    "pay_invoice",
  scopeAttestation: sig,
});
```

**→ ScopeAttestation EIP-712 type**

### Propose an Action

```typescript
const proposal = await brain.agents.propose({
  tenantId: "acme",
  agentId:  agent.id,
  action: {
    type: "pay_invoice",
    invoiceId: "inv_8231",
    amount: "7800_000000",
    asset: "USDC",
  },
});

proposal.actionId;
proposal.decision;       // "ALLOW" | "ESCALATE" | "DENY"
proposal.reason;         // structured reason if not ALLOW
proposal.policy_version;
proposal.approvers;      // for ESCALATE: ["role:cfo"]
proposal.audit_event_id;
proposal.wiki_context;   // Wiki citations the proposal referenced
```

### Handle the Three Outcomes

```typescript
switch (proposal.decision) {
  case "ALLOW":
    // The policy verdict is signed and short-lived (60 sec TTL).
    // Execute immediately.
    const receipt = await brain.actions.execute(proposal.actionId);
    console.log(receipt.tx_hash);
    break;

  case "ESCALATE":
    // Surface to required approvers.
    // The action is in pending state until approved or expired.
    await notifyApprovers(proposal.approvers, proposal);
    break;

  case "DENY":
    // Action will not execute. Inspect reason.
    console.log("Denied:", proposal.reason);
    break;
}
```

### Approve an Escalated Action

Approvers sign an EIP-712 approval. The SDK provides a helper.

```typescript
import { signActionApproval } from "@brain/sdk";

const approvalSig = await signActionApproval({
  actionId: proposal.actionId,
  approverRole: "cfo",
  signer: cfoSigner,
});

await brain.actions.approve(proposal.actionId, {
  approval: approvalSig,
});

// Now the action can execute.
const receipt = await brain.actions.execute(proposal.actionId);
```

### Execute an Approved Action

```typescript
const receipt = await brain.actions.execute(actionId);

receipt.tx_hash;        // bank rail receipt OR on-chain tx hash
receipt.rail;           // "bank_api" | "smart_account" | "x402"
receipt.settled_at;     // ISO timestamp
receipt.audit_event_id;
```

### Subscribe to Action Events

```typescript
const unsubscribe = brain.agents.subscribe(agent.id, {
  onProposed:  (e) => console.log("Proposed:", e),
  onAllowed:   (e) => console.log("Allowed:", e),
  onEscalated: (e) => console.log("Escalated:", e),
  onDenied:    (e) => console.log("Denied:", e),
  onExecuted:  (e) => console.log("Executed:", e),
});

// Later
unsubscribe();
```

### Pause or Revoke an Agent

```typescript
// Pause; preserves identity and reputation
await brain.agents.pause(agent.id);

// Resume
await brain.agents.resume(agent.id);

// Permanently revoke; irreversible
await brain.agents.revoke(agent.id);
```

| State       | What It Means                                         | Reversible |
| ----------- | ----------------------------------------------------- | ---------- |
| **Active**  | Agent can propose actions                             | n/a        |
| **Paused**  | Proposals rejected; identity and reputation preserved | ✅ Yes      |
| **Revoked** | Permanent termination; record preserved for audit     | ❌ No       |

{% hint style="warning" %}
Revoking an agent is irreversible. The `agentId` is marked revoked on-chain. Reputation is preserved for auditability, but no further actions can be proposed.
{% endhint %}
