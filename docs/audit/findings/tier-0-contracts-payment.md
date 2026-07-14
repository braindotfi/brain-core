# Tier 0 Contracts And Payment Path Review

Status as of 2026-07-15.

This note summarizes the remediation branch for the Tier 0 security review findings
recorded in `BRAIN_REVIEW.md` under `## Tier 0: Contracts + Payment Path`.

## Fixed In This Branch

| Finding | Status | Change |
| ------- | ------ | ------ |
| T0-1 | Fixed | `GrantSessionKey` now grants ERC20-mode session keys by setting `capToken` to the allowed token. The printed caps now match the caps enforced at runtime. |
| T0-2 | Fixed | `BrainSmartAccount.grantSessionKey` rejects native-mode keys that allowlist decodable ERC20 selectors. Token transfers must use ERC20 mode. |
| T0-3 | Fixed | TypeScript session-key helper shapes now require explicit `capToken` and raw integer token units. Decimal allowance strings are converted before projection. |
| T0-4 | Fixed | `BrainMCPAgentRegistry` behavior updates and revocations now bind per-agent nonces in the EIP-712 payload, blocking replay of historical signatures. |
| T0-6 | Fixed | `DeployEscrow` and `DeploySmartAccount` now require Base Sepolia chain id before broadcasting. |
| T0-8 | Fixed | The escrow audit and deployed-bytecode gates now require the full audit-approved path for any non-testnet chain, not only Base mainnet. |
| T0-9 | Fixed | API boot now checks explicit `BASE_RPC_URL` with `eth_chainId` and refuses to start when it differs from `BRAIN_BASE_CHAIN_ID`. |
| T0-12 | Fixed | Production boot now fences `attestCounterpartyAgent` and `sumAgentWindowSpend`, so gate checks 5.5 and 8.5 cannot silently degrade to absent-loader behavior. |

## Still Open

| Finding | Status | Notes |
| ------- | ------ | ----- |
| T0-10 | Open | x402 settlement is covered by the generic production live-rail fence, but it is not covered by an equivalent hard human-approval floor. This remains tied to T0-11. |
| T0-11 | Product decision required | Current semantics allow policy `allow` to execute on-chain actions without a recorded approval signature. A hard human-approval floor would change product behavior and should be opt-in until approved. |
| T0-5 | Product decision required | Removing `approve` from the ERC20 session-key selector allowlist is a capability change. Outstanding ERC20 allowances are not clawed back by session-key revocation. |
| T0-13 | Confirmation required | `x402_settle` and `escrow_release` intentionally skip the off-chain reservation gate and rely on on-chain caps plus rail-specific checks. Confirm this is the intended ceiling model. |

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
