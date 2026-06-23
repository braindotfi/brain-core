---
description: Install portable skills that teach an agent to use Brain's MCP surface for a specific finance outcome.
---

# Use Brain Agent Skills

Brain Agent Skills are portable `SKILL.md` recipes for MCP-compatible agent
hosts. Each skill teaches a host agent how to gather the evidence required for a
finance task, call Brain's existing MCP tools, return the policy result, and stop
at the proposal boundary.

The skills add no protocol behavior. Brain remains the source of financial data,
policy decisions, approvals, and audit records.

## Available Skills

| Skill | Outcome | Authority boundary |
| --- | --- | --- |
| `brain-reconciliation` | Match statement and ledger activity | Proposes matches |
| `brain-subscription` | Review recurring charges and price changes | Proposes findings |
| `brain-vendor-risk` | Review vendors and changed destinations | Confirm/reject ceiling |
| `brain-collections` | Prepare overdue-invoice follow-up | Proposes a reviewed draft |
| `brain-fraud-anomaly` | Flag suspicious transactions | Notify-only; card freeze requires an explicit request |
| `brain-cash-forecast` | Project cash and runway | Proposes a forecast |
| `brain-dispute` | Build a linked evidence packet | Proposes the packet |
| `brain-payment` | Prepare an invoice payment | Proposes a payment intent |
| `brain-treasury` | Prepare a sweep or account top-up | Proposes a payment intent |
| `brain-revenue-intel` | Surface churn and expansion signals | Notify-only |
| `brain-compliance` | Review policy decisions and audit gaps | Confirm/reject ceiling |

## Install

The skill repository is
[`braindotfi/brain-skills`](https://github.com/braindotfi/brain-skills).
Installation syntax depends on the agent host. A host that supports marketplace
commands can install the repository and then select a skill:

```text
/plugin marketplace add braindotfi/brain-skills
/plugin install brain-reconciliation@brain-skills
```

The skill activates when the user's task matches its frontmatter description.
Credentials are not stored in the skill. The host resolves the operator's Brain
JWT at runtime.

## Runtime Contract

Every skill follows the same sequence:

1. Connect to `POST /v1/agents/mcp` using JSON-RPC 2.0.
2. Authenticate with the operator's runtime-supplied Brain JWT.
3. Read only the scopes declared by the selected agent.
4. Gather the agent's required evidence.
5. Respect the agent's minimum-confidence floor and authority boundary.
6. Call `agent.action.propose`, or `payment_intent.propose` for Payment and
   Treasury, with an `idempotency_key`.
7. Return the proposal id, policy decision, unresolved evidence, and next review
   step.

The proposing host does not sign, dispatch, or move funds. Payment and Treasury
have no default action, so a financial proposal requires an explicit request or a
matched event with complete evidence.

## Agent-Specific Safety Boundaries

High risk does not imply one shared default-action rule:

- Vendor Risk and Compliance have no default action and have a confirm/reject
  ceiling.
- Fraud and Anomaly legitimately defaults to `notify`; notification changes
  nothing. Its consequential `freeze_card` action is explicit-request-only and
  never selected from an anomaly trigger.
- Payment and Treasury categorically omit a default action because they are the
  two money-moving skills.

These fields are generated from Brain's internal-agent definitions into a
public-safe specification. The skill repository's CI compares every
`brain-meta.json` file with that specification and rejects drift.

## Updating the Skills

The private source of truth remains the internal-agent catalog. The sync path is:

```text
brain-core internal-agent definitions
  -> tools/skills-spec/generate.ts
  -> brain-skills/spec/brain-agents.json
  -> scripts/check-drift.mjs
```

When an agent definition changes, regenerate the specification, update the
affected skill copy, and run the drift check before publishing.

## Related

- [Let an External Agent In](let-an-external-agent-in.md)
- [Internal Agents](../concepts/internal-agents.md)
- [MCP Server](../mcp-server/overview.md)
- [MCP Tools](../mcp-server/tools.md)
