# @brain/execution

Proposal and execution state machine. Agents, rails, MCP server.

See `Brain_MVP_Architecture.md` for this layer's responsibilities and `Brain_API_Specification.yaml` for the endpoint contract.

## Payment rails

All money movement runs through `runPreExecutionGate` (the §6 16-check gate) and
the durable outbox (H-04); a worker claims `pending` rows and dispatches the
rail. Each rail implements the `Rail` interface (`src/rails/types.ts`).

| Kind            | Implementation                              | Status                                 |
| --------------- | ------------------------------------------- | -------------------------------------- |
| `bank_ach`      | `rails/ach-plaid.ts` (`AchPlaidRail`)       | H-05. Real, injected Plaid client      |
| `onchain_base`  | `rails/onchain-base.ts` (`OnchainBaseRail`) | H-06. Real, injected viem+KMS executor |
| `erp_writeback` | `rails/stubs.ts` (`ErpWritebackStubRail`)   | stub (NetSuite deferred)               |

The `*StubRail` classes in `rails/stubs.ts` fabricate receipts (`stub: true`) and
**fail closed under `NODE_ENV=production`** (`assertStubRailsAllowed`). They are
retained for dev/test only.

### H-05. Plaid Transfer ACH rail

`AchPlaidRail` runs the two-step Plaid flow. `/transfer/authorization/create`
then `/transfer/create`. Keying both on the outbox row's `idempotency_key`
(Plaid `client_transaction_id`) so a re-dispatch never double-pays. `dispatch`
returns a `status: 'pending'` receipt; settlement is async.

Settlement arrives on the Plaid `TRANSFER_EVENTS_UPDATE` webhook
(`/raw/webhooks/plaid`). The handler resolves `transfer_id → outbox row` and
calls `applyPlaidTransferEvent`, which maps a terminal success → `markSettled`
and a return/failure/cancel → `markFailed`.

The rail takes an injected `PlaidTransferClient`; construct the real client at
boot:

```ts
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid"; // workspace dep
const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[cfg.PLAID_ENV],
    baseOptions: {
      headers: { "PLAID-CLIENT-ID": cfg.PLAID_CLIENT_ID, "PLAID-SECRET": cfg.PLAID_SECRET },
    },
  }),
);
// adapt PlaidApi → PlaidTransferClient (the two methods the rail uses)
```

Env: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`. Sandbox round-trip test is
gated behind `BRAIN_PLAID_SANDBOX_INTEGRATION=1` (`tools/plaid-sandbox`).

### H-06. On-chain Base rail

`OnchainBaseRail` calls `BrainSmartAccount.executeViaSessionKey(nonce, target,
value, data)`. It reads the live per-holder nonce (`getSessionKeyNonce`, H-03)
and threads it in. A stale nonce reverts on-chain with `BadNonce`, a re-entrant
target with `ReentrantCall`; both surface as `execution_rail_declined`.

The signing key lives in **Azure Key Vault**: build a viem `Account` whose
`signTransaction`/`signMessage` proxy to Key Vault via `@azure/keyvault-keys` +
`@azure/identity` (managed identity). The raw private key is never read into
process memory. The rail depends only on the injected `OnchainExecutor`
interface, so this wiring stays out of the rail logic.

Env: `BASE_RPC_URL`, `BRAIN_BASE_CHAIN_ID` (8453 mainnet / 84532 sepolia),
`BRAIN_AZURE_KEY_VAULT_URL`.

### Sandbox / verification status

The live SDKs (`plaid`, `viem`, `@azure/keyvault-keys`, `@azure/identity`) and a
local `anvil`/Postgres are **not available in the CI sandbox**, so the live
clients, the Plaid sandbox round-trip, and the anvil deploy-and-dispatch
integration test are blocked there. The rail _logic_ is fully covered by unit
tests against mock clients (`ach-plaid.test.ts`, `onchain-base.test.ts`):
two-call sequencing + idempotency-key threading (ACH), nonce threading +
replay/re-entrancy revert handling + the KMS no-raw-key invariant (on-chain).
