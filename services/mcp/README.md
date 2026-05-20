# @brain/mcp

Brain's Model Context Protocol server. External AI agents connect to
Brain through this surface using any MCP-compatible client (Claude
Desktop, custom-built agents, third-party integrations).

Architecture and design rationale: see `docs/mcp-architecture.md` at
the repo root.

## What's Exposed

- **10 tools** across 4 capability groups: `ledger:read`, `wiki:read`,
  `raw:write`, `payment_intent:propose` / `agent:propose`.
- **6 resources** with stable `brain://...` URIs.
- **5 prompts** that templatize canonical financial questions.

## What's Not Exposed

- `payment_intent.execute`, execution is Brain-internal. Agents propose;
  approvals + the §6 gate decide.
- Direct access to `services/raw` / `services/ledger` / `services/policy`
  / `services/audit` databases. Every tool goes through the same
  controlled service methods that the HTTP API uses.
- Cross-tenant data. Every request is bounded by the agent's
  `tenant_id` JWT claim plus Postgres RLS.

## Local Development

```bash
pnpm -C services/mcp run typecheck
pnpm -C services/mcp run test
```

The MCP server is mounted on the existing `services/execution` Fastify
app at `POST /agents/mcp`. Boot the execution service to expose it.

## Where the Logic Lives

| File                    | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `src/server.ts`         | `BrainMcpServer`, JSON-RPC dispatcher + auth + audit |
| `src/dispatcher.ts`     | JSON-RPC 2.0 message parsing                         |
| `src/auth.ts`           | Agent identity + scope-hash verification             |
| `src/tools/*.ts`        | One file per capability group                        |
| `src/resources.ts`      | `brain://...` URI resolver                           |
| `src/prompts.ts`        | Canonical question templates                         |
| `src/transport/http.ts` | Fastify-compatible request handler                   |
