# ADR 0007: The external contract audit gates mainnet

- Status: Accepted
- Date: 2026-06-07

## Context

`BrainEscrow` is the only funds-custodying contract. A bug in a custody contract
is not a degraded experience, it is lost customer money with no undo. Internal
review and testnet exercise reduce risk but do not substitute for an independent
external audit. The danger is that "we will get the audit before mainnet"
quietly becomes "we shipped to mainnet and the audit slipped", so the gate must
be a hard fence the runtime enforces, not a checklist item.

## Decision

Mainnet escrow is double-fenced. The api refuses to boot in production when the
chain is Base mainnet (8453) and an escrow address is configured unless **both**:
(1) the committed `contracts/audit-status.json` is `approved` for chain 8453 with
an auditor, an audited commit, a report reference, zero open critical/high
findings, and build evidence; and (2) the deployed runtime bytecode matches the
audited build via `eth_getCode` (immutable-masked). Marking `audit-status.json`
`approved` is itself guarded by a CI script so it cannot be faked in a hurry.

## Consequences

- It is structurally impossible to start a production mainnet build that custodies
  funds before the audit is genuinely complete and the deployed code matches what
  was audited.
- A mainnet deploy with mismatched (for example hot-patched) bytecode fails closed.
- Mainnet custody is blocked until R-01 is resolved; this is intended and is
  stated plainly in the release notes and risk register.

## Enforced by

- `services/api/src/composition/escrow-audit-gate.ts`: the boot fence.
- `scripts/check-audit-status.mjs`: forbids a hollow `approved` attestation.
- `scripts/check-escrow-audit-marker.mjs`: keeps the marker honest.
