# Brain MCP Architecture

Brain Finance Inc. | brain.fi v0.3, MCP integration

This document specifies how Brain exposes the Model Context Protocol
(MCP) so that AI agents, internal and external, can connect to and
operate against the six-layer protocol under the same governance the
HTTP API enforces.

It is the design companion to the implementation in
`services/mcp/`. The HTTP API contract still lives in
`Brain_API_Specification.yaml`; this doc adds the MCP surface that
sits on top of `/v1/agents/mcp`.

## Why MCP

`Brain_MVP_Architecture.md` §3 Layer 5 already describes the agent
boundary:

> External agents (tenant-authorized) connect via MCP and get
> bidirectional access to Brain: they can read Ledger and Wiki,
> contribute Raw artifacts, and propose actions that pass through Policy
> and Audit like any internal agent would.

MCP is the standard those external agents reach for. By implementing the
spec rather than a Brain-specific RPC, we let any MCP-aware client
(Claude Desktop, custom-built agents, third-party integrations) connect
without bespoke wiring. The protocol does not change the layer model ,
it is a _transport_ over the same six-layer policy/audit boundary.

## What MCP Gives an Agent (and What It Does Not)

An MCP client connected to Brain can:

- **List and call tools**: typed actions like `ledger.transactions.list`,
  `wiki.question`, `payment_intent.propose`. Each tool maps to a
  controlled service method.
- **List and read resources**: typed identifiers like
  `brain://ledger/accounts/{id}` that resolve to a JSON snapshot.
- **List and get prompts**: canonical question templates the client
  composes against (e.g. `wiki.question.cash_flow`).

An MCP client _cannot_:

- Bypass the §6 deterministic pre-execution gate. `payment_intent.execute`
  is **not** exposed as an MCP tool; agents may only `propose`. Execution
  is a separate Brain-internal path triggered by approval workflows.
- Read another tenant's data. Every request is bounded by the JWT's
  `tenant_id` claim and Postgres RLS.
- Mutate Raw, Ledger, Policy, or Audit stores directly. Every write goes
  through the controlled service helpers we already shipped.
- Skip an audit event. Every tool call emits one
  `agent.mcp.tool_called` audit event, regardless of outcome.

## Where MCP Lives in the Layer Map

```
   ┌────────────────────────────────────────────────────────────┐
   │  External AI agents (Claude Desktop, custom agents, ...)   │
   └────────────────┬───────────────────────────────────────────┘
                    │ JSON-RPC 2.0 over HTTPS
                    │ Bearer JWT (principal_type=agent)
                    ▼
   ┌────────────────────────────────────────────────────────────┐
   │  POST /v1/agents/mcp     (Fastify route in services/exec)  │
   └────────────────┬───────────────────────────────────────────┘
                    │
                    ▼
   ┌────────────────────────────────────────────────────────────┐
   │  BrainMcpServer  (services/mcp/src/server.ts)              │
   │   • JSON-RPC dispatcher (initialize / tools.* / etc.)      │
   │   • Agent identity verification (JWT + agents table state) │
   │   • Scope verification against scopeHash registered in     │
   │     BrainMCPAgentRegistry                                   │
   │   • Per-tool input validation                              │
   │   • Per-tool audit emission                                │
   └────────────────┬───────────────────────────────────────────┘
                    │
       ┌────────────┼────────────┬─────────────┬──────────────┐
       ▼            ▼            ▼             ▼              ▼
   ┌───────┐    ┌───────┐    ┌───────┐    ┌──────────┐    ┌───────┐
   │ RAW   │    │LEDGER │    │ WIKI  │    │ POLICY   │    │AUDIT  │
   └───────┘    └───────┘    └───────┘    └──────────┘    └───────┘
```

The MCP server is **client-side of every other layer**. It calls the
same `ILedgerService`, `IWikiMemoryService`, `IPaymentIntentService`,
`IRawEvidenceService`, `IAgentService` contracts that the HTTP route
handlers do. This is why a tool call gets identical policy gating and
audit treatment to an HTTP call, they are the same code paths.

## Transport

MCP supports stdio, SSE, and Streamable HTTP. Brain ships **HTTP single-
shot** at v0.3:

- One HTTP POST = one JSON-RPC request.
- Response body = one JSON-RPC response.
- No server-initiated notifications (no resource subscriptions; no
  progress events).
- No session state; auth is per-request via the Bearer JWT.

This is the simplest viable subset and matches Brain's existing
"every HTTP request is independently auth'd" pattern. SSE / streaming
is a post-MVP extension when there's demand for long-running tool calls
or real-time resource updates.

## Authentication and Authorization

Every MCP request must carry a Bearer JWT with `principal_type=agent`.
The JWT is verified by the existing `authPlugin` upstream of the route
handler, same code path as every other Brain endpoint.

After JWT verification, the MCP server runs four extra checks:

1. **Agent record exists and is `active`.** Lookup against the `agents`
   table; reject with `agent_not_registered` if missing or in any non-
   `active` state. This catches keys that were issued before on-chain
   confirmation.
2. **Scope hash matches the on-chain attestation.** The agent's
   `scope_hash` (stored in `agents.scope_hash`) must match the hash on
   `BrainMCPAgentRegistry.getAgent(agentId).scopeHash`. Hash-mismatch =
   the off-chain record drifted from the on-chain ground truth, which is
   a security event. Reject and audit.
3. **Tool requires a scope the agent holds.** Each tool declares
   required scopes (e.g. `payment_intent.propose` needs
   `payment_intent:propose`). The agent's JWT scopes must contain the
   tool's required set.
4. **Tenant equality.** `agents.tenant_id` must match the JWT's
   `tenant_id`. (Defense in depth, JWT verification already enforces
   this via the auth plugin.)

For hot-path performance, on-chain scope-hash check (2) is cached for
60 seconds per (agent_id, scope_hash) pair. Cache miss falls through to
an `eth_call` against Base RPC.

## Tool Surface (V0.3)

Ten tools across four capability groups. Each tool name is an
`{layer}.{noun}.{verb}` string; that's the convention.

### `ledger:read` Capability

| Tool                         | Maps to                            | Notes                             |
| ---------------------------- | ---------------------------------- | --------------------------------- |
| `ledger.account.get`         | `LedgerService.getAccount`         | Returns account + latest balance. |
| `ledger.accounts.list`       | `LedgerService.listAccounts`       | Filter by status/type.            |
| `ledger.transactions.list`   | `LedgerService.listTransactions`   | Rich filter set.                  |
| `ledger.obligations.list`    | `LedgerService.listObligations`    | Open obligations.                 |
| `ledger.counterparties.list` | `LedgerService.listCounterparties` | Search by `q`.                    |

### `wiki:read` Capability

| Tool            | Maps to                   | Notes                                |
| --------------- | ------------------------- | ------------------------------------ |
| `wiki.question` | `askWiki` orchestrator    | Returns answer + cited evidence ids. |
| `wiki.page.get` | `WikiPageService.getPage` | Markdown body of a page.             |

### `raw:write` Capability

| Tool             | Maps to                                                           | Notes                            |
| ---------------- | ----------------------------------------------------------------- | -------------------------------- |
| `raw.contribute` | `IRawEvidenceService.ingest` with `source_type=agent_contributed` | Caps confidence at 0.5 per §3.2. |

### `payment_intent:propose` And `agent:propose` Capabilities

| Tool                     | Maps to                       | Notes                                                  |
| ------------------------ | ----------------------------- | ------------------------------------------------------ |
| `payment_intent.propose` | `PaymentIntentService.create` | Returns intent + PolicyDecision. **Never `.execute`.** |
| `agent.action.propose`   | `IAgentService.propose`       | Non-financial proposal.                                |

A tool that the agent isn't scoped for is still **listed** (`tools/list`
returns the full registry); attempting to **call** it returns
`agent_scope_insufficient`. Listing without calling is information
disclosure, but only of the surface, not the data, and it lets a
generic MCP client present a discoverable tool catalog.

## Resource Surface

Resources are read-only typed identifiers. Brain exposes:

| URI scheme                                     | Resolves to                        |
| ---------------------------------------------- | ---------------------------------- |
| `brain://ledger/accounts/{account_id}`         | Account row + latest balance       |
| `brain://ledger/transactions/{transaction_id}` | Transaction row                    |
| `brain://ledger/obligations/{obligation_id}`   | Obligation row                     |
| `brain://ledger/payment-intents/{id}`          | PaymentIntent row + PolicyDecision |
| `brain://wiki/pages/{slug}`                    | Wiki page (markdown body)          |
| `brain://audit/events/{id}`                    | Audit event with inclusion proof   |

Resources are syntactic sugar over the equivalent tools, useful for
clients that want stable URIs they can pin in their reasoning context.
The same scope checks apply.

## Prompt Surface

Prompts are templates the client can fill in and send back to
`wiki.question`. Brain ships:

- `wiki.question.cash_flow_summary`, "What is the cash flow for
  {period}?"
- `wiki.question.bills_due`, "What bills are due in the next {days}
  days?"
- `wiki.question.spending_change`, "Why did spending change in
  {period}?"
- `wiki.question.invoice_status`, "What's the status of invoice
  {invoice_number}?"
- `wiki.question.subscriptions`, "Which subscriptions are active and
  cancelable?"

Each prompt declares its argument list. The client interpolates and
posts the result to the `wiki.question` tool. Prompts are convenience;
the Q&A surface is the same.

## Audit Semantics

Every tool call emits exactly one audit event:

```json
{
  "layer": "agent",
  "actor": "agent_<ulid>",
  "action": "agent.mcp.tool_called",
  "inputs": {
    "tool": "payment_intent.propose",
    "tool_args_hash": "sha256(args)",
    "scope_check_passed": true
  },
  "outputs": {
    "ok": true,
    "result_kind": "payment_intent",
    "result_id": "pi_<ulid>"
  }
}
```

When a tool transitively writes through Brain's services (e.g.
`payment_intent.propose` calls `PaymentIntentService.create`), those
service calls emit their own audit events. The `agent.mcp.tool_called`
event is the **outer wrapper** that lets an investigator pivot from "the
agent was here" to "and these are the things it did." The events are
linked by `request_id`.

When a tool call fails (scope insufficient, validation failure, gate
rejection), the `agent.mcp.tool_called` event is still emitted with
`outputs.ok = false` and the failure code. There is no path where an
agent calls a tool and no audit event lands.

## Capability Negotiation

The `initialize` handshake response advertises:

```json
{
  "protocolVersion": "2024-11-05",
  "serverInfo": {
    "name": "brain-mcp",
    "version": "0.3.0"
  },
  "capabilities": {
    "tools": { "listChanged": false },
    "resources": { "listChanged": false, "subscribe": false },
    "prompts": { "listChanged": false }
  }
}
```

`listChanged` and `subscribe` are false because Brain v0.3 doesn't push
notifications to the client. A client that asks for them gets a
graceful empty response.

## Failure-Mode Semantics

Mapped onto the JSON-RPC error code space + Brain's error registry:

| Brain code                   | JSON-RPC code | When                                                                 |
| ---------------------------- | ------------- | -------------------------------------------------------------------- |
| `auth_token_missing`         | -32001        | No JWT or invalid bearer                                             |
| `auth_scope_insufficient`    | -32002        | Tool requires a scope the agent doesn't hold                         |
| `agent_not_registered`       | -32003        | JWT valid but agent row missing/revoked                              |
| `request_body_invalid`       | -32602        | JSON-RPC `params` failed schema validation                           |
| `payment_intent_gate_failed` | -32004        | Only relevant when proposing a payment that fails policy on creation |
| internal                     | -32603        | Anything else                                                        |

Standard JSON-RPC -32700 (parse error) and -32601 (method not found) are
also surfaced for malformed transport / unknown method names.

## Versioning

The MCP protocol version (`protocolVersion`) is the wire-level number
the SDK manages. The Brain MCP server version (`serverInfo.version`) is
`0.3.0` at first ship and tracks the architecture version.

Adding a tool: minor bump (0.3.1). Removing a tool or breaking a tool's
input schema: major bump (1.0.0) + a deprecation cycle described in the
same standard as `/execution/*` legacy routes (Engineering Standards
§4.3).

## Testing Strategy

Unit tests at `services/mcp/src/**/*.test.ts`:

- Dispatcher: every JSON-RPC method routes correctly.
- Auth: scope mismatch, expired JWT, agent non-active.
- Each tool: happy path + scope-failed path + service-error path.
- Audit: every tool call emits exactly one outer event.

Integration tests (skipped without `DATABASE_URL`):

- A mock MCP client connects, calls `initialize`, `tools/list`, and
  exercises every tool against a live Postgres + the golden-path seed.

The recorded-prompt harness (Brain Engineering Standards §8.2) extends
to MCP: each canonical agent scenario is a JSON-RPC transcript, replayed
against frozen Ledger state, with the LLM response recorded.

## Out of Scope At v0.3

- Streamable HTTP transport (SSE for server→client notifications).
- Resource subscriptions.
- Tool listing with progress callbacks.
- Multi-message session protocol.
- Prompt argument validation against rich JSON Schema (we ship simple
  string-typed args; arrays/objects post-v0.3).

These ship behind a `mcp:streaming` feature flag when there's a real
demand. Today the single-shot HTTP path is sufficient for every external
agent we've talked to.
