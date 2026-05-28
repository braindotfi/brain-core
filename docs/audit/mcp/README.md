# Audit Area: MCP

**Scope:** The MCP JSON-RPC 2.0 server at `services/mcp/` — protocol handling, tool registration, transport, auth chain, capability negotiation, and whether the 10 claimed tools are actually wired and invokable.

**Reports planned:**
- `runtime.md` — Tool registry validation (10 tools: 5 ledger reads, 2 wiki reads, 1 raw.contribute, 2 propose-only actions), transport implementation (`registerMcpRoute` mounting, single-shot HTTP, no SSE), auth chain (JWT → agent active → on-chain scope-hash 60s cache), no-execute defense (P1.2 hardening), cross-service DB-access concern (prior audit: `auth.ts:117` queried execution's `agents` table directly).

**Out of scope here:** MCP documentation under `mcp-server/` (docs-only, not runtime).

**Relevant files:** `services/mcp/src/`, `services/mcp/src/tools/`, `services/mcp/src/transport/http.ts`, prior audit cross-service violation note.
