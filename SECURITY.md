# Security

How Brain keeps money movement safe, and how a third party can verify it
independently. This is the 90-minute diligence summary; the full detail lives in
`Brain_Engineering_Standards.md` and `Brain_MVP_Architecture.md`.

## Safety model summary

No agent and no LLM can move money on its own. Every financial action passes
through the **§6 deterministic pre-execution gate** (`shared/src/gate/gate.ts`) —
13 numbered checks plus 4 hardening additions (`1.5`, `7.5`, `9.5`, `11.5`):
identity, behavior-hash pinning, scope, policy match, source account,
counterparty + sanctions, amount limit, ledger-state binding, balance, evidence
present + semantically supporting the action, approval quorum, duplicate-payment
guard, policy-decision creation, and a mandatory audit-before/after pair. Each
check is deterministic — no LLM judgment substitutes for any precondition. A
failure is a hard stop; the gate never catches-and-continues. Execution is
Brain-internal and only reachable through `PaymentIntentService`.

## Layer boundaries (CI-enforced)

The architecture's safety rests on boundaries that CI fails the build on:

| Invariant                                                   | Enforced by                              |
| ----------------------------------------------------------- | ---------------------------------------- |
| No money moves outside the §6 gate / `PaymentIntentService` | `scripts/check-gate-bypass.mjs`          |
| Policy never reads Wiki text (reads Ledger only)            | `scripts/check-policy-no-wiki-read.mjs`  |
| Wiki never writes Ledger                                    | `scripts/check-wiki-no-ledger-write.mjs` |
| Scopes stay within the sanctioned vocabulary                | `scripts/check-scope-vocab.mjs`          |
| Shadow→live agent promotion is gated                        | `scripts/check-promotion-readiness.mjs`  |

Tenant isolation is enforced at the **storage layer** (Postgres RLS on every
tenant table + `FORCE ROW LEVEL SECURITY` under the `brain_app` non-owner role;
see `infra/db-roles.sql`), never shared-query-with-filter.

## Audit anchor and independent verification

Every material state change emits an append-only, Merkle-chained audit event.
Batches are anchored on-chain (`BrainAuditAnchor`). The Merkle scheme is
byte-identical between the off-chain builder (`services/audit/src/merkle.ts`,
`verifyInclusion`) and the contract, so a proof verifies both ways.

A third party verifies **without trusting Brain**:

- `POST /v1/audit/verify` — public, unauthenticated, pure function: given a
  Merkle root, a leaf, and a proof path, returns whether the leaf is included.
- Re-check the anchor transaction on the Base block explorer (link in any
  rendered proof view, `GET /v1/proof/{action_id}/view`).

## Deployed contract addresses

Brain protocol contracts on Base Sepolia (chain 84532). Mainnet deployment is
blocked on the external smart-contract audit.

| Contract                  | Base Sepolia (staging)                              | Base mainnet           |
| ------------------------- | --------------------------------------------------- | ---------------------- |
| `BrainAuditAnchor`        | `0xb900add824064098342c869ff83efdeb05eb95ce`        | pending external audit |
| `BrainPolicyRegistry`     | `0x92d1CC5c46eAE229C8A9dD95a334cec0cE33CAD9`        | pending external audit |
| `BrainSmartAccount`       | `0x8cC094d03676d29c8cE0267480f58188E7F1E23D`        | pending external audit |
| `BrainMCPAgentRegistry`   | `0xd1558828ef31630164aa8942dd41bc63a4d8bed7`        | pending external audit |
| `BrainEscrow`             | `0x5924BD26Bc827FB3cAd6f3a0DBDC793562555Cc0`        | pending external audit |
| `BrainReputationRegistry` | `0xcEf6C25aE3DF9c5cfC0B3E11D031eAAa2c26026C`        | pending external audit |

`BrainEscrow` and `BrainReputationRegistry` were deployed 2026-05-28 via
`contracts/script/DeployEscrow.s.sol` and `DeployReputationRegistry.s.sol`. The
arbiter / attestor on both is the `BRAIN_SESSION_KEY` EOA in staging; production
must rotate to a Safe multi-sig before mainnet.

### External (third-party) contracts referenced by Brain rails

| Surface               | Address / endpoint                                  | Network      |
| --------------------- | --------------------------------------------------- | ------------ |
| x402 facilitator      | `https://x402.org/facilitate` (Coinbase testnet)    | base-sepolia |
| USDC (x402 + escrow)  | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`        | base-sepolia |

## Audit status

**RFP drafted; engagement pending founder approval.** See
`contracts/AUDIT-SCOPE.md` and `contracts/AUDIT-RFP-DRAFT.md`. Update this line as
the engagement progresses (drafted → scheduled → draft findings → final).

## Threat model summary

From Engineering Standards §12.2 (full detail in `docs/threat-model.md`):

- **Cross-tenant data leak** via app bug → mitigated by storage-layer RLS.
- **Agent credential compromise** → short-lived (15-min) JWTs; on-chain
  revocation for external agents; behavior-hash pinning (gate check 1.5).
- **Malicious policy injection** → EIP-712 signature + content-hash verification.
- **Smart-contract exploit** → external audit + bug bounty pre-mainnet.
- **LLM prompt injection** → structured input validation, Ledger-grounded
  retrieval, and never executing unverified LLM output.
- **Wiki-as-truth attack** → Policy never reads Wiki; the deterministic gate
  decides on Ledger state only.
- **Duplicate / replayed payment** → gate check 11.5 hard-rejects even with a
  valid approval.

## Bug bounty

Pre-launch — no public bounty yet. Vulnerability reports are handled privately
via the contact below; a public program will launch alongside mainnet.

## Contact

security@brain.fi <!-- TODO(brain-hardening): confirm the canonical address -->
Please do not open public issues for security reports.
