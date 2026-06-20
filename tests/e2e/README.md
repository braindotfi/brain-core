# Brain E2E Proof Tests

These three suites prove the three Series A claims from
`Brain_MVP_Architecture.md` §6. They run against staging
(`https://api.sandbox.brain.fi/v1` by default) on every main-branch
merge, gated before the production promotion step in
`.github/workflows/main.yml`.

## Environment

| Variable                     | Required by  | Notes                                                                                         |
| ---------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `BRAIN_BASE_URL`             | all 3 suites | Staging endpoint.                                                                             |
| `BRAIN_TOKEN`                | suites 1 + 2 | Tenant-admin JWT minted by seed script.                                                       |
| `BRAIN_TEST_TENANT_ID`       | suites 1 + 2 | `tnt_...` for the seeded test tenant.                                                         |
| `BRAIN_TEST_VENDOR_ID`       | suites 1 + 3 | `cp_...` or ULID of a seeded vendor entity.                                                   |
| `BRAIN_EXTERNAL_AGENT_TOKEN` | suite 3      | JWT for an external agent (`principal_type=agent`) pre-registered in `BrainMCPAgentRegistry`. |

When a variable is absent, the affected suite skips, local runs don't
fail CI, but staging runs that are missing any variable should.

## Suites

- `five-layer.e2e.test.ts`, end-to-end happy path (raw → wiki → policy
  → execution → audit).
- `wiki-compounding.e2e.test.ts`, monotonic increase across 12
  synthetic months in entity count, relation density, avg confidence,
  and human-confirmed count.
- `external-agent-mcp.e2e.test.ts`, external agent via MCP: ping +
  wiki:read + execution:propose, each gated by the same policy and
  logged to the same audit chain as an internal agent.
- `onchain-executor.testnet.e2e.test.ts`, drives the real
  `OnchainBaseRail` against a deployed `BrainSmartAccount` on Base
  Sepolia (no HTTP server). Read path (nonce) needs only RPC + the
  smart-account address; the revert path (surfaces a real on-chain
  revert as `execution_rail_declined`, gas only) also needs a
  gas-funded throwaway session key + a target; the success case
  (executes once, then asserts the on-chain replay guard by re-sending
  at the **consumed** nonce and requiring a revert) is double-gated
  behind `BRAIN_TESTNET_SUCCESS_ENABLED` and needs a **granted** session
  key (target + selector allowlisted, cap ≥ value, matching
  `policy_version`) on a funded account. (Outbox idempotency is proved
  separately in the execution outbox suite, not here.) CI job:
  `testnet_onchain_executor_e2e` (gated on
  `vars.TESTNET_ONCHAIN_E2E_ENABLED`).

### Testnet on-chain executor env

| Variable                                | Required by        | Notes                                                         |
| --------------------------------------- | ------------------ | ------------------------------------------------------------- |
| `BRAIN_TESTNET_RPC_URL`                 | all on-chain cases | Base Sepolia RPC URL.                                         |
| `BRAIN_TESTNET_SMART_ACCOUNT`           | all on-chain cases | Deployed `BrainSmartAccount` address.                         |
| `BRAIN_TESTNET_CHAIN_ID`                | optional           | Default `84532` (Base Sepolia).                               |
| `BRAIN_TESTNET_SESSION_KEY`             | revert + success   | 0x 32-byte priv key; the holder/signer. Gas-funded throwaway. |
| `BRAIN_TESTNET_TARGET`                  | revert + success   | Call target address.                                          |
| `BRAIN_TESTNET_POLICY_VERSION`          | optional           | 0x 32-byte policy digest the key is bound to.                 |
| `BRAIN_TESTNET_SUCCESS_ENABLED`         | success case       | `"true"` to run the value-moving case (granted-key fixture).  |
| `BRAIN_TESTNET_SUCCESS_DATA` / `_VALUE` | success case       | Calldata / wei for the granted action.                        |
