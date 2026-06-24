---
description: Install all 11 Brain Finance skills and the official MCP connection as one Claude plugin.
---

# Install the Brain Finance Plugin

The `brain-finance` plugin packages 11 portable `SKILL.md` recipes and the
official Brain MCP connection in one installation. Each skill teaches Claude
Code how to gather the evidence required for a finance task, call Brain's MCP
tools, return the policy result, and stop at the proposal boundary.

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
In Claude Code, add Brain's public marketplace and install the single plugin:

```text
/plugin marketplace add braindotfi/brain-skills
/plugin install brain-finance@brain-skills
```

The installation adds all 11 skills and configures the `brain` MCP server at
`https://mcp.brain.fi`. Individual skills activate when the user's task matches
their frontmatter descriptions. Credentials are not stored in the plugin; the
host resolves the operator's Brain token at runtime.

The current package version is `0.1.0-beta.1`. Its manifests, skills, drift
checks, isolated installation tests, and static security review are complete.
Live availability remains gated on the human Phase 0 proof described below.

## OAuth and Runtime Authentication

The plugin stores no credential. An unauthenticated MCP connection is expected
to receive an HTTP `401` challenge that points to Brain's OAuth protected-resource
metadata at:

```text
https://mcp.brain.fi/.well-known/oauth-protected-resource
```

The host uses that metadata to discover the authorization server, show the
requested scopes, obtain user consent, and receive a runtime bearer token. Brain
then verifies the token's tenant and scopes, including the on-chain
`scope_hash`, before accepting a tool call.

This is the required server contract, not a claim that the public OAuth flow has
passed launch verification. Phase 0 must prove discovery, consent, token
issuance, an authorized read, and a confirm/reject proposal from both supported
hosts.

## Install a Standalone Skill in Agensi

Agensi installs standalone skill archives and does not carry the Claude
plugin's root `.mcp.json`. Build the archives from the reviewed source:

```bash
git clone https://github.com/braindotfi/brain-skills.git
cd brain-skills
npm run build:agensi
```

This produces 11 archives under `dist/agensi/`. The directory is generated and
gitignored; ZIP files are not stored in the repository. Each built `SKILL.md`
includes the prerequisite to connect `https://mcp.brain.fi` manually before
use.

## Verify the Package

The public repository contains the source and package checks:

```bash
git clone https://github.com/braindotfi/brain-skills.git
cd brain-skills
npm test
```

The test suite validates the plugin and marketplace manifests, checks all 11
skills against Brain's generated public specification, verifies that every MCP
reference copy is byte-identical, enforces money-mover and frontmatter safety
invariants, builds all 11 Agensi archives, and performs an isolated Claude
marketplace installation.

The generated specification must be no more than 30 days old. Changes to Brain's
internal agent definitions trigger a private `brain-core` workflow that
regenerates the public-safe specification and opens or updates a reviewable pull
request in `brain-skills`.

The repository also includes:

- `SECURITY.md` and a file-grounded eight-point static review;
- injection-rejection examples for untrusted documents, instructions, and
  payment destinations;
- `scripts/verify-phase0.mjs` and a two-host human verification runbook;
- listing drafts that remain blocked until Phase 0 passes.

## Runtime Contract

Every skill follows the same sequence:

1. Connect to `https://mcp.brain.fi` using MCP over HTTP.
2. Authenticate with the operator's runtime-supplied Brain token.
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

- Vendor Risk and Compliance have a confirm/reject ceiling.
- Fraud and Anomaly legitimately defaults to `notify`; notification changes
  nothing. Its consequential `freeze_card` action is explicit-request-only and
  never selected from an anomaly trigger.
- Payment and Treasury categorically omit a default action because they are the
  two money-moving skills.

These fields are generated from Brain's internal-agent definitions into a
public-safe specification. The skill repository's CI compares every
`brain-meta.json` file with that specification and rejects drift.

## Phase 0 Launch Gate

Phase 0 is not an automated CI claim. A human must use a dedicated sandbox
tenant to prove:

1. installation in Claude Code and standalone-skill installation in Agensi;
2. OAuth metadata discovery, scope review, and user consent;
3. an authorized `ledger.accounts.list` call;
4. a `payment_intent.propose` result ending in `pending_approval` or `rejected`;
5. absence of execute, settle, or sign tools; and
6. no balance or settlement change.

The exact checklist and evidence requirements live in
[`docs/phase0-runbook.md`](https://github.com/braindotfi/brain-skills/blob/main/docs/phase0-runbook.md).

## Updating the Skills

The private source of truth remains the internal-agent catalog. The sync path is:

```text
brain-core internal-agent definitions
  -> tools/skills-spec/generate.ts
  -> brain-skills/spec/brain-agents.json
  -> brain-skills/scripts/check-drift.mjs
```

When an agent definition changes, regenerate the specification, update the
affected skill copy, and run the drift check before publishing. The automated
cross-repository workflow requires a human-provisioned
`BRAIN_SKILLS_PUSH_TOKEN`; the token is referenced by name and is never embedded
in source or generated output.

## Related

- [Let an External Agent In](let-an-external-agent-in.md)
- [Internal Agents](../concepts/internal-agents.md)
- [MCP Server](../mcp-server/overview.md)
- [MCP Tools](../mcp-server/tools.md)
