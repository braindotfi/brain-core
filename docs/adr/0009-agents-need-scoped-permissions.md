# ADR 0009: Agents hold scoped, attested permissions

- Status: Accepted
- Date: 2026-06-07

## Context

An agent with broad, ambient authority is a single compromise away from abusing
every capability it could ever touch. Worse, if the agent's permissions live only
in the operator's database, the operator (or anyone who breaches it) can silently
widen them. For external agents acting on a tenant's behalf, the permission set
needs to be both narrow and tamper-evident.

## Decision

Agents hold scoped permissions, attested on-chain. Scopes follow a `{layer}:{verb}`
vocabulary. An external agent registers in `BrainMCPAgentRegistry` with an
EIP-712 scope attestation, and the MCP auth chain checks that the JWT's
`scope_hash` matches the on-chain attestation (60s cache, Base RPC fallback)
before any tool runs, then narrows further by tool scope and tenant equality.
Capabilities are declared in a manifest, and agent-contributed data is bounded
independently by the provenance/confidence rules (ADR 0004).

## Consequences

- A compromised agent is limited to its attested scopes; it cannot self-escalate.
- Widening an agent's authority requires an on-chain attestation change, which is
  visible, not a quiet database edit.
- Tenant equality is checked on every call, so an agent for one tenant cannot act
  on another (covered by the cross-tenant negative test).

## Enforced by

- `services/mcp/src/auth.ts` + `auth.test.ts`: the JWT to active to on-chain
  `scope_hash` to tool-scope to tenant-equality chain, with negative tests.
- `scripts/check-scope-vocab.mjs`: keeps the `{layer}:{verb}` scope vocabulary
  consistent.
- `BrainMCPAgentRegistry` (`contracts/src/`): the on-chain scope attestation.
