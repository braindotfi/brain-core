# Brain Console

The console is the web interface for managing Brain integrations. Connect sources, register agents, draft and sign policies, inspect audit traces, and monitor live agent activity, all without writing code.

{% hint style="info" %}
The console is a thin client over the same REST API that humans and agents share. Anything visible here is also accessible programmatically.
{% endhint %}

### What You Can Do

<table data-view="cards"><thead><tr><th></th><th></th></tr></thead><tbody><tr><td><strong>🔌 Source Connectors</strong></td><td>Connect Plaid, direct bank APIs, on-chain wallets, ERPs, accounting tools, payroll, and processors.</td></tr><tr><td><strong>🧾 Ledger Browser</strong></td><td>Drill into transactions, invoices, counterparties, with provenance to every Raw artifact.</td></tr><tr><td><strong>🧠 Wiki Explorer</strong></td><td>Ask the tenant's memory graph natural-language questions; inspect citations.</td></tr><tr><td><strong>📋 Policy Editor</strong></td><td>Write policy in plain English. Inspect the compiled deterministic form before signing.</td></tr><tr><td><strong>🤖 Agent Manager</strong></td><td>Register internal agents, scope external agents, monitor reputation.</td></tr><tr><td><strong>✋ Approval Queue</strong></td><td>Review and approve actions that policy escalated.</td></tr><tr><td><strong>🛡️ Audit Trail</strong></td><td>Browse every audit event with Merkle proofs and Base anchor links.</td></tr><tr><td><strong>🔑 API Keys</strong></td><td>Generate, rotate, and revoke API keys per environment.</td></tr></tbody></table>

### Environments

| Environment    | URL                 | Network      |
| -------------- | ------------------- | ------------ |
| **Sandbox**    | `console.brain.dev` | Base Sepolia |
| **Production** | `console.brain.fi`  | Base Mainnet |

### API Key Types

| Type           | Prefix         | Use                                           |
| -------------- | -------------- | --------------------------------------------- |
| **Server key** | `brain_sk_...` | Backend integrations; never expose to clients |
| **Anchor key** | `brain_ak_...` | Reserved for self-hosted Brain anchorers      |
| **Public key** | `brain_pk_...` | Read-only client-side access                  |

{% hint style="warning" %}
Server keys are bearer tokens. Treat them like passwords. Brain logs every API call with a key fingerprint for audit purposes.
{% endhint %}

### Webhooks

Subscribe to real-time events. Every webhook payload is signed with HMAC-SHA256 using your webhook secret. Verify the `X-Brain-Signature` header before processing.

| Event                       | When It Fires                                |
| --------------------------- | -------------------------------------------- |
| `source.connected`          | A new source has been connected for a tenant |
| `ledger.record.created`     | A new structured record landed in the Ledger |
| `agent.proposal.created`    | An agent has proposed an action              |
| `policy.decision.escalated` | An action was escalated for human approval   |
| `action.executed`           | An action settled on its rail                |
| `audit.root.anchored`       | A Merkle root was anchored on Base           |

### Traces

Every request through Brain is assigned a unique `traceId`.

```
[ traceId: 8f3a92...                                 ]
   │
   ├─ API call           POST /v1/agents/payments-v1/propose
   ├─ Wiki query         retrieved 12 Ledger refs, 3 Raw refs
   ├─ Policy evaluated   v3, decision: ESCALATE
   ├─ Approval received  approver: role:cfo
   ├─ Action executed    bank_api → Mercury, ACH initiated
   ├─ Audit anchored     batch 4127, root 0xab12...cd34
   └─ Receipt            tx 0xfe98...7654 on Base
```
