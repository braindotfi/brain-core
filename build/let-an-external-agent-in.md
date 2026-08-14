---
description: Register an external agent and use the MCP surface with tenant-scoped credentials.
---

# Let an External Agent In

Goal: register an external agent and let it use the tenant-scoped MCP surface
under Brain's existing authentication, policy, and audit controls.

### Register the Agent

The currently live registration route is
`POST /v1/execution/agents/register`. It requires an agent identifier, role,
and display name. The SDK calls that route.

```typescript
const agent = await brain.agents.register({
  agent_id: "ag_vendor_assistant",
  role: "vendor_management",
  display_name: "Vendor Assistant",
  scope_hash: "0x...",
  onchain_address: "0x...",
  registered_tx: "0x...",
});

console.log(agent.id, agent.registered_tx);
```

The optional `scope_hash`, `onchain_address`, and `registered_tx` fields are the
only optional registration fields in the current public request shape.

### Available Agent Scopes

An external agent can hold these canonical scopes: `ledger:read`, `wiki:read`,
`raw:read`, `raw:write`, `payment_intent:propose`, and `execution:propose`.
There is no public SDK `grantScope` or `revoke` method today. Scope issuance and
agent credentials are controlled by the registered-agent flow.

External agents can propose but cannot execute money movement. Execution remains
inside the PaymentIntent lifecycle and passes the section 6 gate.

### Connect to MCP

The MCP server shares the API host. Production and staging use these endpoints:

```text
POST https://api.brain.fi/v1/agents/mcp
POST https://staging-api.brain.fi/v1/agents/mcp
```

The agent authenticates with its tenant-scoped JWT. Tool discovery returns only
the tools the principal's scopes allow.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

### Ask a Grounded Question

The authenticated JWT supplies the tenant. Do not include a tenant identifier in
the tool arguments.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "wiki.question",
    "arguments": {
      "question": "What invoices are overdue?",
      "max_evidence_depth": 3
    }
  }
}
```

`wiki.question` accepts `question`, optional `as_of`, and optional
`max_evidence_depth`.

### Review Agent Activity

```typescript
const page = await brain.audit.list({
  actor: "agent:ag_vendor_assistant",
  since: "2025-09-01T00:00:00.000Z",
  limit: 100,
});

for (const event of page.events) {
  console.log(event.action, event.created_at);
}
```

### Halt and Restore a Registered Agent

The current SDK exposes operational controls rather than per-scope mutation.

```typescript
await brain.agents.halt("ag_vendor_assistant");
await brain.agents.restore("ag_vendor_assistant");
```

Both operations require `payment_intent:approve`. Restoring an agent does not
resume payment intents paused by its earlier halt.

### What's Next

- [MCP Server Overview](../mcp-server/overview.md)
- [Audit Every Action](audit-every-action.md)
