# ADR 0003: Policy is deterministic, never an LLM

- Status: Accepted
- Date: 2026-06-07

## Context

The temptation in an AI-native product is to let a model make the final
judgment: "is this payment OK?". Models are non-deterministic, non-reproducible,
promptable, and impossible to audit after the fact. A payment decision must be
explainable, repeatable, and provable to an auditor or a regulator. That rules
out LLM judgment at the decision boundary.

## Decision

The policy layer is a deterministic rule VM. It evaluates a signed policy DSL
against machine-readable Ledger state and writes exactly one `policy_decisions`
row per evaluation. The §6 pre-execution gate is likewise deterministic and
fail-closed: 13 numbered checks plus 10 hardening additions, each a yes/no over
typed inputs. LLM judgment never replaces a deterministic precondition. The gate
reads Ledger, never Wiki (narrative recall is not evidence).

## Consequences

- Every decision is reproducible from its inputs and provable from the persisted
  `gate_checks` snapshot and `policy_decisions` row.
- Models can still propose, summarize, and explain (ADR 0002, 0004), but they sit
  outside the decision boundary.
- Policy authors get a linter, simulator, and diff tooling because the policy is
  a deterministic artifact, not a prompt.

## Enforced by

- `shared/src/gate/`: the deterministic gate; fast-check property tests cover it.
- `scripts/check-policy-no-wiki-read.mjs`: fails the build if Policy reads Wiki.
- `services/policy/src/`: one `policy_decisions` row per evaluation; never
  executes or mutates Ledger/Audit.
