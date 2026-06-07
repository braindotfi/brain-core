# ADR 0002: MCP can propose but never execute

- Status: Accepted
- Date: 2026-06-07

## Context

The MCP server is the surface external agents talk to. Agents are useful exactly
because they act with some autonomy, which is also exactly why they cannot be
trusted with an "execute payment" button. The boundary between "an agent asked
for something" and "Brain decided to do it" must be a hard wall, not a
convention.

## Decision

The MCP surface is propose-only. It exposes tools to propose, cancel, and list
payment actions and to read Ledger/Wiki, but **no `payment_intent.execute` tool
exists, ever**. Execution is Brain-internal, behind the §6 gate (ADR 0001,
0003). `payment_intent.cancel` is the only state-mutating tool besides propose,
and it is restricted to the proposing agent and to `proposed` / `pending_approval`
states.

## Consequences

- An external agent, even a fully compromised one, cannot move money. The worst
  it can do is propose intents that the gate will independently evaluate and a
  policy/human may reject.
- The agent gets a clean mental model: it expresses intent; Brain owns the
  decision and the action.
- Adding a convenient "propose and auto-execute" tool is forbidden, because it
  would reintroduce the wall it removes.

## Enforced by

- `services/mcp/src/tools/registry.no-execute.test.ts`: asserts no tool name
  contains `execute` and the capability set excludes `payment_intent:execute`;
  snapshots the full tool list so a new tool is a visible diff.
- `services/mcp/src/auth.ts` + `auth.test.ts`: the JWT to agent-active to
  on-chain-`scope_hash` to tool-scope to tenant-equality chain, with negative
  tests for each rejection (including cross-tenant).
