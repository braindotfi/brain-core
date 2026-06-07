# ADR 0006: The audit log is anchored on-chain

- Status: Accepted
- Date: 2026-06-07

## Context

An append-only audit log that the operator also controls can, in principle, be
rewritten by that operator. For a system that makes autonomous financial
decisions, "trust us, the log is intact" is not good enough for a counterparty,
an auditor, or a regulator. The integrity claim needs a witness the operator
cannot quietly alter.

## Decision

The audit log is append-only and Merkle-chained per tenant, and its Merkle root
is anchored on-chain (`BrainAuditAnchor` on Base). A published root cannot be
re-published. The off-chain Merkle builder and the on-chain contract use
byte-identical hashing (`keccak256` with 0x00/0x01 domain separation) so an
inclusion proof verified off-chain matches what was anchored. `POST
/v1/audit/verify` is a public, unauthenticated pure function for third-party
verification. A background consistency verifier detects any fork or gap in the
per-tenant chain and raises metrics plus a critical log.

## Consequences

- Tampering with historical audit events would break the chain and contradict an
  already-anchored root, which anyone can check.
- Counterparties and auditors can verify inclusion without trusting Brain's
  infrastructure.
- Anchoring has a cost and a dependency on a chain; the audit log remains usable
  if anchoring lags, because anchoring is a periodic commitment, not a per-event
  write.

## Enforced by

- `services/audit/src/merkle.ts` + `contracts/src/BrainAuditAnchor.sol`:
  matching hashing, verified by property and Foundry tests.
- `services/audit/src/audit-consistency.ts`: the fork/gap verifier.
- `shared/src/audit/emitter.ts`: per-tenant hash chain + exactly-once
  idempotency key.
