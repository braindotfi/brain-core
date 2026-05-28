# Audit Area: Services

**Scope:** Per-workspace implementation reality for each of the 11 TypeScript services. Each report covers intended architecture vs actual implementation, route registration, business logic correctness, test reality, and layer-boundary compliance.

**Reports planned (one file per service or paired where tightly coupled):**
- `api.md` — Composition root, auth wiring, cross-cutting middleware, migrations (tenants).
- `raw-and-ledger.md` — Artifact ingestion pipeline + normalize worker (paired: shared BullMQ pipeline).
- `wiki.md` — pgvector, LLM Q&A, annotation rate-limiting, ledger-write violation checks.
- `policy.md` — Rule VM, EIP-712 signer, signed-policy allowlist, `compareDecimal` fix.
- `execution.md` — PaymentIntent state machine, ApprovalService, sagas, outbox worker, invoice shortcut.
- `audit.md` — Merkle chain, webhook dispatch, on-chain anchor, verify endpoint.

**Out of scope here:** Agent routing and internal agents (see `orchestration/`), MCP (see `mcp/`).

**Plaid version skew flag:** `services/api` uses `plaid@^42.2.0`; `services/raw` uses `plaid@^27.0.0`. Must be verified for API incompatibility during the `raw-and-ledger.md` turn.
