# ADR 0004: Source provenance is required on derived data

- Status: Accepted
- Date: 2026-06-07

## Context

Brain derives financial facts (Ledger rows) and narrative memory (Wiki pages)
from ingested evidence. A derived fact with no traceable source is a rumor: it
cannot be verified, disputed, or unwound, and it cannot safely feed a payment
decision. Agent-contributed data compounds the risk, since an agent can be wrong
or adversarial.

## Decision

Every derived Ledger row and Wiki page carries `provenance`, `confidence`, and
`source_ids` / `evidence_ids`. Missing these is a bug, not a soft warning.
Agent-contributed rows are capped at `confidence: 0.5`. Confidence is a policy
lever (a rule can require `agent.confidence.gte`), not a gate check, and it can
only be raised upward by corroborating evidence (for example reconciliation
raising an obligation toward 0.9). Writes flow upward only; human/agent
contributions enter through Raw, never by mutating a higher layer.

## Consequences

- Any fact that influences money has a chain back to source evidence, which is
  what makes the audit proof meaningful.
- An unverified agent claim cannot masquerade as ground truth: the 0.5 cap plus
  the confidence-gated policy lever bound its authority until evidence raises it.
- Producers must thread provenance through; there is no "just write the value"
  shortcut.

## Enforced by

- `schemas/entity/`: Ledger rows must validate against the JSON Schemas, which
  carry the provenance fields.
- The §6 gate's evidence checks (9.5 evidence-semantic validation) read Ledger
  evidence, not Wiki narrative.
- RFC 0004 ingestion: `POST /raw/{id}/parsed` is the first writer, keeping
  extraction a Raw contribution so the layer boundary holds.
