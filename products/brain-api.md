# Brain API

The Brain API is the **single surface that humans, internal agents, and external agents all share**. There is no separate "agent SDK." Authentication is the only thing that differs for each caller.

| Caller             | Authentication                                                            |
| ------------------ | ------------------------------------------------------------------------- |
| **Human**          | OAuth/SSO (Auth0)                                                         |
| **Internal agent** | Brain-issued service token                                                |
| **External agent** | SIWX (Sign-In With X, EIP-4361 over Base) plus EIP-712 scope attestations |

### Three Protocol Surfaces

The same primitives are exposed in three ways. Pick the one that fits the caller.

<table data-view="cards"><thead><tr><th></th><th></th></tr></thead><tbody><tr><td><strong>🌐 REST</strong></td><td>Standard HTTPS endpoints under <code>/v1/...</code>. Best for server-side integrations.</td></tr><tr><td><strong>⚡ JSON-RPC</strong></td><td>Single endpoint, batched calls, structured errors. Best for high-throughput clients.</td></tr><tr><td><strong>🔌 MCP</strong></td><td>Model Context Protocol server. Best for LLM-driven external agents.</td></tr></tbody></table>

### What You Can Do

| Capability                      | Endpoints                                                        |
| ------------------------------- | ---------------------------------------------------------------- |
| **Connect sources**             | `POST /v1/sources`, `POST /v1/raw/ingest`                        |
| **Read structured data**        | `GET /v1/ledger/transactions`, `POST /v1/wiki/question`          |
| **Manage policy**               | `POST /v1/policy`                                                |
| **Register and use agents**     | `POST /v1/agents`, `POST /v1/agents/{id}/propose`                |
| **Approve and execute actions** | `POST /v1/actions/{id}/approve`, `POST /v1/actions/{id}/execute` |
| **Verify audit**                | `GET /v1/audit/{id}`, `GET /v1/audit/{id}/proof`                 |

[**→ Full API reference**](/broken/pages/oOfC0aWDt9rFPXjdQ300)

### Provenance On Every Response

Every response from Wiki, Policy, and Agent endpoints includes provenance metadata. Claims are traceable.

| Field            | What It Contains                                    |
| ---------------- | --------------------------------------------------- |
| `citations[]`    | IDs of Ledger and Raw records the answer depends on |
| `policy_version` | The policy version that was evaluated               |
| `audit_event_id` | The audit event under which this call was logged    |

{% hint style="success" %}
You never have to ask "where did this number come from?" Every answer carries the citations needed to follow it back to the source evidence.
{% endhint %}

### Authentication at a Glance

```http
POST /v1/auth/siwx
Content-Type: application/json

{ "message": "...", "signature": "0x..." }

→ { "agent_token": "...", "expires_at": "...", "scopes": [...] }
```

[**→ Full authentication reference**](../apis/authentication.md)
