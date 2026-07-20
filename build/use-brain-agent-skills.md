---
description: Install all 11 Brain Finance skills and the official MCP connection, as a Claude plugin or from any MCP-capable agent runtime.
---

# Install the Brain Finance Plugin

The `brain-finance` plugin packages 11 portable `SKILL.md` recipes and the
official Brain MCP connection in one installation. Each skill teaches an agent
how to gather the evidence required for a finance task, call Brain's MCP tools,
return the policy result, and stop at the proposal boundary.

The Claude plugin is the turnkey packaging, but the skills are provider-neutral.
The portable core is the Brain MCP server, a standard MCP surface with OAuth 2.0
discovery, so any MCP-capable runtime can connect. See
[Use with Other Agent Runtimes](#use-with-other-agent-runtimes) below.

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
The `https://mcp.brain.fi` endpoint is deployed and serves the OAuth 2.0
discovery contract described below. Full launch remains gated on the human
Phase 0 proof, which exercises an authenticated read and proposal end to end.

## OAuth and Runtime Authentication

The plugin stores no credential. An unauthenticated MCP connection receives an
HTTP `401` challenge whose `WWW-Authenticate: Bearer` header points to Brain's
OAuth protected-resource metadata at:

```text
https://mcp.brain.fi/.well-known/oauth-protected-resource
```

That metadata names Brain's authorization server (`https://auth.brain.fi`) and
the scopes it understands. The host uses it to discover the authorization
server, show the requested scopes, obtain user consent, and receive a runtime
bearer token. Brain then verifies the token's tenant and scopes, including the
on-chain `scope_hash`, before accepting a tool call.

The discovery contract is live and can be probed today. Phase 0 remains the
launch gate for the authenticated path: it must prove consent, token issuance,
an authorized read, and a confirm/reject proposal from each supported host.

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

## Use with Other Agent Runtimes

The skills are not Claude-specific. Because the Brain MCP server is a standard
MCP surface with OAuth 2.0 discovery, any MCP-capable runtime can register it
and get the same policy-gated, propose-only tools. Build a provider-neutral
bundle from the reviewed source:

```bash
git clone https://github.com/braindotfi/brain-skills.git
cd brain-skills
npm run build:portable
```

This writes `dist/portable/`, which contains `skills-manifest.json`, a
machine-readable index of all 11 skills (id, description, trigger patterns,
readable scopes, propose tool, and action types), plus each skill body as a
provider-neutral instruction file. An orchestrator on any provider can read the
manifest to route a request to the right skill.

Three invariants make this portable:

1. Point the runtime at `https://mcp.brain.fi` over MCP HTTP.
2. Never embed a credential. The host supplies the runtime bearer token, and
   Brain resolves tenant and scopes from it through the OAuth discovery flow.
3. Keep human approval between propose and execute. There is no execute, settle,
   or sign tool on the surface.

Copy-paste registration examples for OpenAI (Agents SDK and Responses API),
Google Gemini, and Anthropic live in the repository under
[`docs/providers/`](https://github.com/braindotfi/brain-skills/tree/main/docs/providers).
These are MCP-compatibility guides; each integration should still be exercised
against a sandbox tenant before production use.

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

The drift check warns when the generated specification is more than 30 days old
and recommends regenerating it; the build no longer fails on age alone, since
spec correctness is enforced by the field-level comparison. Changes to Brain's
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
   Treasury. Duplicate proposal protection is server-side; the agent does not
   pass an idempotency key.
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
