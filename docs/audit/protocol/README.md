# Audit Area: Protocol

**Scope:** The `protocol/` directory is documentation only (no `package.json`, no source). This area audits the gap between the protocol specification and the runtime implementation.

**Reports planned:**

- `spec-vs-reality.md`. For each protocol document (`the-six-layer-stack.md`, `raw-and-ledger.md`, `the-wiki.md`, `policy-and-permissioning.md`, `the-pre-execution-gate.md`, `agents.md`, `agent-contributions.md`, `payment-intents.md`, `audit-and-proof.md`): is the described behaviour implemented, partial, aspirational, or contradicted by the code?

**Note:** `smart-contracts/` and `mcp-server/` are also documentation-only; their runtime equivalents are `contracts/` (Foundry) and `services/mcp/` respectively. Covered in `contracts/` and `mcp/` areas.

**Relevant files:** `protocol/*.md`, `Brain_MVP_Architecture.md`, `Brain_API_Specification.yaml`.
