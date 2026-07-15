# Tier 0 Contracts And Payment Path Review

Status as of 2026-07-15.

This note summarizes the remediation branch for the Tier 0 security review findings
recorded in `BRAIN_REVIEW.md` under `## Tier 0: Contracts + Payment Path`.

## Fixed In This Branch

| Finding | Status | Change                                                                                                                                                          |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0-1    | Fixed  | `GrantSessionKey` now grants ERC20-mode session keys by setting `capToken` to the allowed token. The printed caps now match the caps enforced at runtime.       |
| T0-2    | Fixed  | `BrainSmartAccount.grantSessionKey` rejects native-mode keys that allowlist decodable ERC20 selectors. Token transfers must use ERC20 mode.                     |
| T0-3    | Fixed  | TypeScript session-key helper shapes now require explicit `capToken` and raw integer token units. Decimal allowance strings are converted before projection.    |
| T0-4    | Fixed  | `BrainMCPAgentRegistry` behavior updates and revocations now bind per-agent nonces in the EIP-712 payload, blocking replay of historical signatures.            |
| T0-6    | Fixed  | `DeployEscrow` and `DeploySmartAccount` now require Base Sepolia chain id before broadcasting.                                                                  |
| T0-8    | Fixed  | The escrow audit and deployed-bytecode gates now require the full audit-approved path for any non-testnet chain, not only Base mainnet.                         |
| T0-9    | Fixed  | API boot now checks explicit `BASE_RPC_URL` with `eth_chainId` and refuses to start when it differs from `BRAIN_BASE_CHAIN_ID`.                                 |
| T0-10   | Fixed  | `x402_settle` now has a hard approval floor unless the signed policy permits on-chain settlement and sets an `x402_autonomous_max_amount` covering the amount.  |
| T0-11   | Fixed  | `onchain_transfer` and `escrow_release` require at least one recorded human approval even when policy returns `allow`; x402 autonomy is value-capped by policy. |
| T0-12   | Fixed  | Production boot now fences `attestCounterpartyAgent` and `sumAgentWindowSpend`, so gate checks 5.5 and 8.5 cannot silently degrade to absent-loader behavior.   |
| T0-5    | Fixed  | The payment-key grant script now issues only ERC20 `transfer` and `transferFrom` selectors. `approve` remains supported by the contract for non-payment keys.   |
| T0-13   | Closed | `x402_settle` and `escrow_release` intentionally skip off-chain reservations. On-chain caps are the spend ceiling, with the B1 human-approval floor above them. |

## Still Open

| Finding | Status | Notes                                                                                 |
| ------- | ------ | ------------------------------------------------------------------------------------- |
| None    | Closed | Group B owner decisions closed the remaining Tier 0 contracts and payment-path items. |

## Group B Execution Semantics

Policy `allow` no longer means approval-free execution for every on-chain action.
`onchain_transfer` and `escrow_release` require a recorded human approval at gate
check 11 before any rail dispatch. `x402_settle` may execute autonomously only
when the matched signed policy rule sets both `onchain_settlement_permitted: true`
and `x402_autonomous_max_amount: { currency, value }`, and the intent amount is
at or below that value. Missing, malformed, wrong-currency, or over-cap policy
data fails closed to the human approval path.

The off-chain reservation gate remains intentionally skipped for `x402_settle`
and `escrow_release`. Their spend ceilings are the on-chain session-key caps
(`maxPerTx`, `maxPerPeriod`) and escrow `remaining` amount, with the hard
human-approval floor above those caps.

## Verification Run So Far

- `forge test --match-contract BrainSmartAccountTest`
- `forge test --match-contract BrainMCPAgentRegistryTest`
- `forge test --match-contract DeployScriptsTest`
- `pnpm --filter @brain/api test -- escrow-audit-gate.test.ts`
- `pnpm --filter @brain/api test -- payment-loaders-prod-fence.test.ts`
- `pnpm --filter @brain/api typecheck`
- `node --test scripts/__tests__/production-readiness.test.mjs scripts/__tests__/check-escrow-audit-marker.test.mjs`
- `pnpm run check-no-em-dashes`

Full-suite status is tracked in the PR before merge.
