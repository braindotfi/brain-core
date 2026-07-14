# Brain Scope Vocabulary

## Format

All scopes follow the `{layer}:{verb}` pattern defined in `shared/src/auth/scopes.ts`.
The canonical source of truth is `VALID_SCOPES` in that file. This document is a
developer-friendly reference; the runtime check is the code.

## Full Scope Inventory (24 scopes, MVP)

| Scope                    | Granted to            | Purpose                                            |
| ------------------------ | --------------------- | -------------------------------------------------- |
| `raw:read`               | human, agent          | Read ingested artifacts and source list            |
| `raw:write`              | human, agent          | Ingest artifacts (`/raw/ingest`)                   |
| `raw:admin`              | human (tenant root)   | Source management, tombstone                       |
| `ledger:read`            | human, agent          | Read accounts, transactions, balances              |
| `ledger:write`           | human                 | Mutate ledger rows (human contributions)           |
| `ledger:admin`           | human (tenant root)   | Schema and migration operations                    |
| `wiki:read`              | human, agent          | Wiki Q&A and page retrieval                        |
| `wiki:write`             | human                 | Write-through annotations                          |
| `wiki:admin`             | human (tenant root)   | Page management                                    |
| `policy:read`            | human, agent          | List and evaluate policies                         |
| `policy:write`           | human                 | Create and update policy rules                     |
| `policy:admin`           | human (tenant root)   | Activate/deactivate policies                       |
| `policy:sign`            | human (tenant root)   | EIP-712 sign policy approvals                      |
| `execution:read`         | human, agent          | Read payment intents and actions                   |
| `execution:write`        | human                 | Cancel / update intents                            |
| `execution:admin`        | human (tenant root)   | Admin override on execution                        |
| `execution:propose`      | **agent only**        | Propose a payment intent or non-financial action   |
| `payment_intent:propose` | human, agent          | Create a payment intent (same gate as above)       |
| `payment_intent:approve` | human (approver role) | Approve a pending payment intent                   |
| `payment_intent:execute` | internal (Brain only) | Execute a payment intent past the §6 gate          |
| `audit:read`             | human, agent          | Read audit events and Merkle proofs                |
| `audit:write`            | human                 | Register and manage webhook endpoints              |
| `audit:admin`            | human (tenant root)   | Anchor management and compliance export            |
| `surfaces:admin`         | human (tenant admin)  | Install or revoke Slack, Teams, and email surfaces |

## Per-Principal-Type Scope Caps

Each non-human credential class has its own scope allowlist, both defined in
`shared/src/auth/scopes.ts`:

- **MCP agents** registered in `BrainMCPAgentRegistry` hold
  `AGENT_PERMITTED_SCOPES` (5 scopes): `ledger:read`, `wiki:read`, `raw:write`,
  `payment_intent:propose`, `execution:propose`.
- **Per-customer API keys** hold `API_KEY_PERMITTED_SCOPES` (9 scopes): the
  agent set plus the read verbs `raw:read`, `policy:read`, `execution:read`, and
  `audit:read`. API keys may read their own tenant's audit trail, which the
  MCP-agent set withholds. Neither set includes any
  `approve`/`execute`/`admin`/`sign`/`policy:write` scope, so neither class can
  move money or administer anything.

These caps are enforced **at issuance, not at verify time**:

- API-key issuance validates the requested scopes against `API_KEY_PERMITTED_SCOPES`
  (`parseIssuedScopes` in `services/api/src/production-tenancy/api-key-routes.ts`).
- SIWX agent tokens draw their scopes from fixed per-role sets that stay within the
  allowlist (`scopesForRole` in `services/api/src/auth/siwx.ts`).

The JWT verifier (`projectPrincipal` in `shared/src/auth/jwt.ts`) does **not**
re-apply these per-principal-type caps. It only rejects a token whose scopes fall
outside the full `VALID_SCOPES` vocabulary. A token minted with an in-vocabulary but
principal-inappropriate scope would still verify: the caps are trusted to have been
applied when the token was issued.

## Divergence from docs.brain.fi

The public documentation at docs.brain.fi uses `tenant:*` / `*:manage` / `actions:*`
scope examples in some pages. Those names are **stale**. The canonical names are the
`{layer}:{verb}` strings in this file. A GitBook PR is tracked to align all doc
examples with this vocabulary.

## Drift Prevention

`pnpm run check-scope-vocab` (wired into `pnpm run lint`) scans all TypeScript source
files for string literals matching `{word}:{word}` and fails if any is not in the
VALID_SCOPES set. Add new scopes to `shared/src/auth/scopes.ts` first, then use them.
