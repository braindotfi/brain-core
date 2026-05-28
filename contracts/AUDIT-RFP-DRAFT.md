# RFP. Brain smart-contract security audit (DRAFT)

Draft RFP for the external audit of Brain's six Solidity contracts. Paste into
outreach to candidate firms with minimal edits. **Pending founder approval.**

> TODO(brain-hardening): confirm budget ceiling, target dates, and the audited
> commit SHA before sending.

## Engagement summary

Brain Finance is a financial-intelligence protocol whose Agent layer can move
money on-chain under a deterministic pre-execution gate. We are seeking a
security audit of the six MVP smart contracts ahead of Base mainnet deployment.

## Scope

Six contracts, ~1,300 LoC total (Foundry, Solidity ≥0.8.24, non-upgradeable):

| Contract                                    | LoC | Focus                                                                                                                |
| ------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------- |
| **`BrainEscrow`** _(priority)_              | 132 | **Funds custody**. Partial release/refund; solvency; reentrancy; arbiter can't redirect. (+ 56-LoC `IBrainEscrow`.) |
| `BrainAuditAnchor`                          | 135 | Append-only Merkle anchor; `verifyInclusion` parity.                                                                 |
| `BrainPolicyRegistry`                       | 255 | Signed policy versions; EIP-712; no downgrade.                                                                       |
| `BrainSmartAccount`                         | 256 | Session-key execution; H-03 replay + re-entrancy.                                                                    |
| `BrainMCPAgentRegistry`                     | 287 | Agent scope-hash attestation; revocation.                                                                            |
| `BrainReputationRegistry` _(non-custodial)_ | 51  | ERC-8004 reputation pointer; monotonic epoch; attestor-only; **no value path**. (+ 32-LoC interface.)                |

**`BrainEscrow` is the priority**. It is the only contract that custodies user
funds (USDC) and gates the first real mainnet payment; it is currently UNAUDITED
/ testnet-only. **`BrainReputationRegistry` is non-custodial** (no fund path) and
a Policy-input-only artifact. Included for completeness at lower severity. Full
per-contract invariants in `contracts/AUDIT-SCOPE.md`. The audited commit SHA will
be pinned at kickoff.

## Deliverables expected

- Findings report (severity-classified: critical/high/medium/low/informational),
  with a clear reproduction and recommended fix per finding.
- Verification of every invariant listed in `AUDIT-SCOPE.md`, plus on-/off-chain
  Merkle hashing parity (`verifyInclusion` ↔ `services/audit/src/merkle.ts`).
- A fix-review pass after we remediate.
- A final report we may share with design partners / investors.

## Structure & timeline

Two rounds (matches our build cadence):

1. **Mid-build round**. Current contracts, surface design issues early.
2. **Pre-deploy round**. Final contracts + remediations, sign-off for mainnet.

Target: round 1 within ~4 weeks of kickoff; round 2 before mainnet. Exact dates
TBD with the selected firm.

## Budget

Ceiling **~$80k per round** (≈$160k for two rounds), per the Standards §8.3
budget line. Open to fixed-fee or time-boxed proposals.

## Candidate firms

Trail of Bits · OpenZeppelin · Spearbit · ChainSecurity · Sigma Prime.

## What we provide

Repo access (contracts + Foundry tests + gas baselines), `AUDIT-SCOPE.md`,
architecture docs, and a technical point of contact for the duration.

## Contact

security@brain.fi <!-- TODO(brain-hardening): confirm the canonical address -->
