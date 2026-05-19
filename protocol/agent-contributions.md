# Agent Contributions

External agents do not just **read** Brain. With the right scope, they can **contribute** to Brain by pushing artifacts (transcripts, documents, structured observations) into the Raw layer, with cryptographic attribution.

| Property                              | Value                                                      |
| ------------------------------------- | ---------------------------------------------------------- |
| **Scope required**                    | `raw:write` (granted via on-chain `BrainMCPAgentRegistry`) |
| **Tool**                              | `raw.contribute` (MCP)                                     |
| **Source type on artifact**           | `agent_contributed`                                        |
| **Provenance on derived Ledger rows** | `agent_contributed`                                        |
| **Confidence ceiling**                | `0.5` until tenant or human review lifts it                |

{% hint style="info" %}
This is one of Brain's category-defining moves. Most "agent platforms" let agents act. Brain lets agents **contribute back** to the financial substrate, with cryptographic attribution and clear governance.
{% endhint %}

### Why Agents Contribute

Most useful financial signals don't come from banks or ERPs. They come from conversations, emails, contracts, internal observations. An agent that sits in a customer's workflow accumulates context that Brain otherwise has no way to see.

Examples of what agents typically contribute:

| Artifact Type    | What It Captures                                                             |
| ---------------- | ---------------------------------------------------------------------------- |
| **Transcripts**  | Sales calls confirming a deal close, vendor negotiations, board discussions  |
| **Documents**    | Forwarded contracts, signed quotes, statements of work                       |
| **Observations** | "Vendor X confirmed via email that the September invoice was reduced by 15%" |

Without an agent contribution path, this evidence sits in the agent's head (or its short-term context). With one, it lands in Brain's Raw layer, gets fingerprinted and stored, and can be extracted into Ledger rows just like any other Raw artifact.

### How a Contribution Flows

```
External Agent
   │
   │ raw.contribute via MCP, with EIP-712 signature
   ▼
Raw Layer
   │
   │ Stored, content-addressed, attributed to agent
   │ source_type: "agent_contributed"
   │
   │ ──► Quarantine (first N from this agent)
   │     ──► tenant approves agent ──► proceeds
   │
   ▼
Extraction Pipeline
   │
   │ Standard parsers run; produce raw_parsed rows
   │
   ▼
Ledger Layer
   │
   │ Derived rows tagged provenance: "agent_contributed"
   │ confidence ≤ 0.5 until reviewed
```

### What Gets Stored

The Raw artifact carries everything an auditor would need.

| Field                             | Source                                                              |
| --------------------------------- | ------------------------------------------------------------------- |
| `sha256`                          | Content hash, computed by Brain                                     |
| `source_type`                     | `agent_contributed`                                                 |
| `source_ref.agent_id`             | The contributing agent's id                                         |
| `source_ref.signature`            | The agent's EIP-712 signature over content + tenant\_id + timestamp |
| `source_ref.onchain_registration` | The `BrainMCPAgentRegistry` record id                               |
| `blob_uri`                        | Pointer to the encrypted artifact in tenant-scoped Blob storage     |

### Quarantine and Trust Escalation

Brain does not auto-extract from agent contributions on the first N artifacts. By default, the first contributions from a newly registered agent land in **quarantine**: they're stored, hashed, attributed, but not fed into the extraction pipeline.

| Phase                                       | Behavior                                        |
| ------------------------------------------- | ----------------------------------------------- |
| **Quarantine (default: first N artifacts)** | Stored and visible to the tenant; not extracted |
| **Tenant approves agent**                   | Future contributions auto-flow to extraction    |
| **Tenant revokes**                          | Future contributions rejected at the MCP layer  |

This is the safety valve that keeps malicious or buggy agents from polluting the Ledger before the tenant has had a chance to look at what they're contributing.

### Confidence Ceiling

Even after extraction, derived Ledger rows that trace back to an `agent_contributed` Raw artifact carry `provenance = agent_contributed` and have their `confidence` capped at **0.5**. This means:

| Effect                                                            | Detail                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Policy rules can require higher confidence for autonomous actions | Agent-contributed evidence by itself can never auto-approve a payment         |
| Wiki narratives can mark them as "unverified"                     | The narrative explicitly notes that the source is an agent, not a bank or ERP |
| Reconciliation matches treat them as soft evidence                | Stronger sources (bank, ERP) take precedence on conflicts                     |

To lift the cap, a human or a higher-trust source has to corroborate. Once corroborated, the row carries both provenances and the cap lifts.

### Authorization

The `raw:write` scope is one of the five MCP capability scopes. It is granted by the tenant at agent registration time via an EIP-712 signature, and the hash of the canonical scope document is anchored in `BrainMCPAgentRegistry`. Without `raw:write`, calls to `raw.contribute` are rejected with JSON-RPC error `-32004` (scope insufficient).

[**→ MCP Authentication**](../mcp-server/mcp-authentication.md)

### Revocation

Revocation is the tenant calling `revokeAgent` on `BrainMCPAgentRegistry`. Within at most 60 seconds (the on-chain scope-cache window), all subsequent contribution calls are rejected. Already-stored Raw artifacts remain (Raw is immutable), but they no longer feed extraction unless the tenant explicitly re-approves.

### Audit

Every contribution emits both:

| Event                              | Layer     |
| ---------------------------------- | --------- |
| `agent.mcp.tool_called` (outer)    | MCP layer |
| `raw.artifact.contributed` (inner) | Raw layer |

The inner event includes the `sha256`, the contributing `agent_id`, the `tenant_id`, and the EIP-712 signature. A counterparty or auditor can verify the signature offline against the agent's on-chain registration.

### What Agents Must Not Contribute

The MCP server validates artifact types and rejects shapes that don't match the schema. The pipeline also rejects content that:

| Forbidden                                                                     | Reason                                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Already-canonical Ledger rows formatted as documents                          | Agents do not write to Ledger directly; only via Raw extraction |
| Non-financial content the tenant has not opted in to ingesting                | Out of scope                                                    |
| PII fields not allowed by the tenant's data-handling policy                   | Tenant policy boundary                                          |
| Signed payloads where the signature does not match the agent's registered key | Identity boundary                                               |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📥 Raw and Ledger</strong></td><td>The substrate contributions land in.</td><td><a href="raw-and-ledger.md">raw-and-ledger.md</a></td><td></td></tr><tr><td><strong>🛠️ MCP Tools</strong></td><td>The <code>raw.contribute</code> tool reference.</td><td><a href="../mcp-server/tools.md">tools.md</a></td><td></td></tr><tr><td><strong>🪪 BrainMCPAgentRegistry</strong></td><td>Where scope is anchored.</td><td><a href="../smart-contracts/brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>
