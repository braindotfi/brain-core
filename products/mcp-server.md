# MCP Server

Brain runs an **MCP (Model Context Protocol) server** that exposes the same primitives as the REST API, namespaced per capability. External agents speak MCP and never need a Brain-specific SDK.

{% hint style="info" %}
MCP is the open standard for connecting LLM-driven agents to tools and data sources. Any MCP-compatible runtime can call Brain directly.
{% endhint %}

### Tool Namespacing

Brain MCP tools follow a `brain.<layer>.<verb>` naming convention.

<table><thead><tr><th width="250">Tool</th><th>What It Does</th></tr></thead><tbody><tr><td><code>brain.wiki.question</code></td><td>Natural-language query over the tenant's memory graph</td></tr><tr><td><code>brain.ledger.search</code></td><td>Structured search over transactions, invoices, balances, counterparties</td></tr><tr><td><code>brain.agents.propose</code></td><td>Propose an action; receive a policy decision</td></tr><tr><td><code>brain.policy.evaluate</code></td><td>Dry-run a hypothetical action against current policy</td></tr><tr><td><code>brain.audit.proof</code></td><td>Retrieve a Merkle proof for any audit event</td></tr></tbody></table>

### Authentication

External agents authenticate using SIWX before issuing tool calls.

<table><thead><tr><th width="100">Step</th><th>What Happens</th></tr></thead><tbody><tr><td>1</td><td>Agent constructs an EIP-4361 SIWX message identifying itself</td></tr><tr><td>2</td><td>Agent signs with its registered ERC-8004 identity key</td></tr><tr><td>3</td><td>Brain verifies the signature, resolves the agent's record in <code>BrainMCPAgentRegistry</code>, and issues a session token</td></tr><tr><td>4</td><td>Token is presented on every MCP call alongside an EIP-712 ScopeAttestation for the requested capability</td></tr></tbody></table>

### Scope-Based Discovery

When an agent connects, Brain only advertises the tools it has scope for. An agent without `pay_invoice` capability does not see `brain.agents.propose` for that action.

{% hint style="success" %}
Discovery is scoped by reputation and policy compatibility, not just capability. The same tenant can grant different agents access to different subsets of the same tools.
{% endhint %}

### How an External Agent Uses it

A typical external agent loop:

<table><thead><tr><th width="100">Step</th><th>What Happens</th></tr></thead><tbody><tr><td>1</td><td>Agent calls <code>brain.wiki.question</code> to gather context</td></tr><tr><td>2</td><td>Agent reasons about what to do next</td></tr><tr><td>3</td><td>Agent calls <code>brain.policy.evaluate</code> to dry-run the proposed action</td></tr><tr><td>4</td><td>If <code>ALLOW</code>, agent calls <code>brain.agents.propose</code> to formalize it</td></tr><tr><td>5</td><td>If <code>ESCALATE</code>, the proposal is queued for human approval</td></tr><tr><td>6</td><td>Once executed, agent reads <code>brain.audit.proof</code> for the verifiable record</td></tr></tbody></table>

### Example MCP Tool Definition

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
