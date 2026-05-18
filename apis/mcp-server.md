# MCP Server

Brain runs an MCP (Model Context Protocol) server that exposes the same primitives as the REST API. External agents speak MCP and never need a Brain-specific SDK.

### Server Endpoints

<table><thead><tr><th width="250">Environment</th><th>URL</th></tr></thead><tbody><tr><td><strong>Production</strong></td><td><code>mcp.brain.fi</code></td></tr><tr><td><strong>Sandbox</strong></td><td><code>mcp.brain.dev</code></td></tr></tbody></table>

### Authentication

Agents authenticate using SIWX before issuing tool calls.

```
1. Agent constructs an EIP-4361 SIWX message identifying itself
2. Agent signs with its registered ERC-8004 identity key
3. MCP server resolves the agent in BrainMCPAgentRegistry and issues a session token
4. Token is presented on every tool call alongside an EIP-712 ScopeAttestation
```

**→ Authentication reference**

### Tool Namespacing

All Brain MCP tools follow a `brain.<layer>.<verb>` naming convention.

<table><thead><tr><th width="250">Tool</th><th>What It Does</th></tr></thead><tbody><tr><td><code>brain.wiki.question</code></td><td>Natural-language query over the tenant's memory graph</td></tr><tr><td><code>brain.wiki.search</code></td><td>Structured entity search</td></tr><tr><td><code>brain.ledger.search</code></td><td>Structured search over Ledger records</td></tr><tr><td><code>brain.ledger.get</code></td><td>Fetch a single Ledger record by id</td></tr><tr><td><code>brain.policy.evaluate</code></td><td>Dry-run a hypothetical action against current policy</td></tr><tr><td><code>brain.agents.propose</code></td><td>Propose an action; receive a policy decision</td></tr><tr><td><code>brain.agents.list</code></td><td>Discover agents available to a tenant</td></tr><tr><td><code>brain.actions.execute</code></td><td>Execute an approved action</td></tr><tr><td><code>brain.actions.get</code></td><td>Fetch action state</td></tr><tr><td><code>brain.audit.proof</code></td><td>Retrieve a Merkle proof for an audit event</td></tr></tbody></table>

### Scope-Based Discovery

When an agent connects, the server only advertises the tools it has scope for. An agent without `pay_invoice` capability does not see `brain.agents.propose` for that action.

{% hint style="success" %}
Discovery is scoped by reputation and policy compatibility, not just capability. The same tenant can grant different agents access to different subsets of the same tools.
{% endhint %}

### Tool Definition Format

```json
{
  "name": "brain.wiki.question",
  "description": "Ask the tenant's financial brain a natural-language question.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tenantId": { "type": "string" },
      "question": { "type": "string" }
    },
    "required": ["tenantId", "question"]
  }
}
```

### Tool Call Example

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "brain.wiki.question",
    "arguments": {
      "tenantId": "acme",
      "question": "What did we spend on AWS last quarter?"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Last quarter, Acme spent $182,431 on AWS..."
      }
    ],
    "metadata": {
      "citations":      [...],
      "policy_version": 4,
      "audit_event_id": "evt_..."
    }
  }
}
```

### Action Proposal Flow Over MCP

A typical external-agent loop:

<table><thead><tr><th width="250">Step</th><th>Tool</th></tr></thead><tbody><tr><td>1. Gather context</td><td><code>brain.wiki.question</code></td></tr><tr><td>2. Dry-run</td><td><code>brain.policy.evaluate</code></td></tr><tr><td>3. Propose if <code>ALLOW</code></td><td><code>brain.agents.propose</code></td></tr><tr><td>4. If <code>ESCALATE</code>, queue</td><td>(handled by tenant)</td></tr><tr><td>5. Execute</td><td><code>brain.actions.execute</code></td></tr><tr><td>6. Confirm</td><td><code>brain.audit.proof</code></td></tr></tbody></table>

### Error Handling

MCP errors follow JSON-RPC conventions with structured `data` payloads.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Policy denied",
    "data": {
      "code":     "POLICY_DENIED",
      "reason":   "new_counterparty_review_required",
      "trace_id": "trc_..."
    }
  }
}
```
