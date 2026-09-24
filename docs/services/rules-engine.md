# Rules Engine Service

## Purpose

The rules engine stores tenant scoped authority rules for agent proposals. A rule
can leave a proposal in the inbox, deny it before inbox surfacing, or execute it
automatically through the same proposal decision path used by a human reviewer.

## Data Model

Rules are stored in `agent_authority_rules`. Each rule has a UUID, tenant id,
agent, target decision, JSON Logic condition, authority, priority, creator,
updater, timestamps, and enabled state. Deletes are soft deletes.

## Evaluation

At proposal creation, `AgentService.propose` asks the rules engine for enabled
rules matching the tenant and agent. Rules run in priority order. The first
matching rule writes `authority`, `authority_rule_id`, and `authority_decision`
onto the proposal action.

`propose` is the default when no rule matches. `deny` writes a rejected proposal
that does not enter the inbox. `auto` calls the proposal decision service with
`actor=system:rules-engine` and `actorReason=rule:{rule_id}`.

## Safety

Startup validation rejects enabled auto rules for `freeze_card`, `refund`, and
`reject_duplicate`. The same check is applied when creating or patching a rule.

## API

The service exposes `GET /v1/rules`, `GET /v1/rules/{id}`,
`POST /v1/rules`, `PATCH /v1/rules/{id}`, `DELETE /v1/rules/{id}`, and
`POST /v1/rules/preview`.

Read routes require `execution:read`. Write routes require `execution:admin`.
