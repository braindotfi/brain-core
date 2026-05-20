# Brain Scope Vocabulary

## Format

All scopes follow the `{layer}:{verb}` pattern defined in `shared/src/auth/scopes.ts`.
The canonical source of truth is `VALID_SCOPES` in that file. This document is a
developer-friendly reference; the runtime check is the code.

## Full Scope Inventory (23 scopes, MVP)

| Scope                     | Granted to            | Purpose                                           |
| ------------------------- | --------------------- | ------------------------------------------------- |
| `raw:read`                | human, agent          | Read ingested artifacts and source list           |
| `raw:write`               | human, agent          | Ingest artifacts (`/raw/ingest`)                  |
| `raw:admin`               | human (tenant root)   | Source management, tombstone                      |
| `ledger:read`             | human, agent          | Read accounts, transactions, balances             |
| `ledger:write`            | human                 | Mutate ledger rows (human contributions)          |
| `ledger:admin`            | human (tenant root)   | Schema and migration operations                   |
| `wiki:read`               | human, agent          | Wiki Q&A and page retrieval                       |
| `wiki:write`              | human                 | Write-through annotations                         |
| `wiki:admin`              | human (tenant root)   | Page management                                   |
| `policy:read`             | human, agent          | List and evaluate policies                        |
| `policy:write`            | human                 | Create and update policy rules                    |
| `policy:admin`            | human (tenant root)   | Activate/deactivate policies                      |
| `policy:sign`             | human (tenant root)   | EIP-712 sign policy approvals                     |
| `execution:read`          | human, agent          | Read payment intents and actions                  |
| `execution:write`         | human                 | Cancel / update intents                           |
| `execution:admin`         | human (tenant root)   | Admin override on execution                       |
| `execution:propose`       | **agent only**        | Propose a payment intent or non-financial action  |
| `payment_intent:propose`  | human, agent          | Create a payment intent (same gate as above)      |
| `payment_intent:approve`  | human (approver role) | Approve a pending payment intent                  |
| `payment_intent:execute`  | internal (Brain only) | Execute a payment intent past the §6 gate         |
| `audit:read`              | human, agent          | Read audit events and Merkle proofs               |
| `audit:write`             | human                 | Register and manage webhook endpoints             |
| `audit:admin`             | human (tenant root)   | Anchor management and compliance export           |

## External-Agent Permitted Scopes

External agents registered in `BrainMCPAgentRegistry` may hold **at most three scopes**:

```
wiki:read
raw:write
execution:propose
```

Any JWT from a `principal_type=agent` carrying a scope outside this set is rejected
at the auth boundary (`shared/src/auth/scopes.ts: AGENT_PERMITTED_SCOPES`).

## Divergence from docs.brain.fi

The public documentation at docs.brain.fi uses `tenant:*` / `*:manage` / `actions:*`
scope examples in some pages. Those names are **stale**. The canonical names are the
`{layer}:{verb}` strings in this file. A GitBook PR is tracked to align all doc
examples with this vocabulary.

## Drift Prevention

`pnpm run check-scope-vocab` (wired into `pnpm run lint`) scans all TypeScript source
files for string literals matching `{word}:{word}` and fails if any is not in the
VALID_SCOPES set. Add new scopes to `shared/src/auth/scopes.ts` first, then use them.
