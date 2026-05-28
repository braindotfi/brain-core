# Audit Area: Contracts

**Scope:** The Foundry Solidity project at `contracts/` — build correctness, test coverage, ABI alignment with TypeScript callers, deployed addresses, and the forthcoming external audit readiness (`contracts/AUDIT-RFP-DRAFT.md`, `contracts/AUDIT-SCOPE.md`).

**Reports planned:**
- `foundry.md` — Four contracts (`BrainAuditAnchor`, `BrainPolicyRegistry`, `BrainSmartAccount`, `BrainMCPAgentRegistry`): `forge build` result, `forge test` result, Foundry fuzz results (P1.3), ABI match against TS callers in `services/api/src/`, deployed addresses (from `.env.example`), `contracts/AUDIT-SCOPE.md` gap analysis.

**Note:** `smart-contracts/` is documentation-only. The runtime Solidity is in `contracts/src/`. Do not confuse the two directories.

**Relevant files:** `contracts/src/`, `contracts/test/`, `contracts/script/`, `contracts/AUDIT-SCOPE.md`, `contracts/AUDIT-RFP-DRAFT.md`, `services/api/src/main.ts` (viem callers).
