# Payment rails support matrix

Single-page release-manager reference: which rails Brain ships, which are
production-supported, what env they need, what chain they dispatch against,
and how they fail.

> The source of truth for everything in the "Catalog" columns is
> `services/api/src/composition/rail-catalog.ts`. The "Runtime posture"
> columns are derived at boot by `computeRailPostures()` and emitted on the
> `brain.runtime.capabilities` log line (one entry per rail). Anything you
> read here that the log disagrees with is a docs-drift bug; file an issue.

## Quick read

| Rail            | Prod-allowed | Mainnet-ready                         |
| --------------- | ------------ | ------------------------------------- |
| `bank_ach`      | yes          | yes                                   |
| `onchain_base`  | yes          | yes                                   |
| `x402_base`     | yes          | yes                                   |
| `escrow_base`   | yes          | **blocked on external contract audit** |
| `erp_writeback` | **no** (stub-only)  | n/a                            |

To run in `NODE_ENV=production` you must register at least one prod-allowed
rail with all required env vars set; otherwise the boot fence at
`composition/rails-prod-fence.ts` refuses to start (rec #5, batch 3).

## Per-rail detail

### `bank_ach`

| Attribute               | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| Description             | ACH via Plaid Transfer (USD fiat, sandbox + production) |
| Implementation          | `AchPlaidRail` against the real Plaid Transfer client   |
| Chain                   | n/a (off-chain)                                         |
| Required env            | `PLAID_CLIENT_ID`, `PLAID_SECRET`                       |
| Production allowed      | yes                                                     |
| Audit required          | no                                                      |
| Failure mode            | Plaid client throws → §6 audit-after emits `ok: false`; PaymentIntent transitions to `failed` via outbox worker |

### `onchain_base`

| Attribute               | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| Description             | ERC-20 transfer on Base via `BrainSmartAccount` session key    |
| Implementation          | `OnchainBaseRail` over viem with KMS-signed session key        |
| Chain                   | `BRAIN_BASE_CHAIN_ID` (default 84532 Sepolia; 8453 mainnet)    |
| Required env            | `BRAIN_SESSION_KEY`, `BASE_RPC_URL`                            |
| Production allowed      | yes                                                            |
| Audit required          | no (BrainSmartAccount in audit scope; not gated by this rail)  |
| Failure mode            | viem revert or RPC timeout → audit-after `ok: false`           |

### `x402_base`

| Attribute               | Value                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Description             | Per-call USDC settlement via Coinbase x402 facilitator                                      |
| Implementation          | `X402BaseRail` against a real `X402Client`                                                  |
| Chain                   | `BRAIN_BASE_CHAIN_ID` (default 84532 Sepolia; 8453 mainnet)                                 |
| Required env            | `BRAIN_X402_FACILITATOR_URL`, `BRAIN_X402_USDC_ADDRESS`, `BRAIN_SESSION_KEY`, `BASE_RPC_URL`|
| Production allowed      | yes                                                                                         |
| Audit required          | no                                                                                          |
| Failure mode            | facilitator 4xx/5xx → audit-after `ok: false`                                               |

### `escrow_base`

| Attribute               | Value                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Description             | Conditional USDC release via `BrainEscrow.release()` (RFC 0001 §7.6, M2M settlement)                                  |
| Implementation          | `EscrowBaseRail` over `OnchainExecutor`                                                                               |
| Chain                   | `BRAIN_BASE_CHAIN_ID` (84532 Sepolia ok; **8453 mainnet blocked on audit**)                                           |
| Required env            | `BRAIN_ESCROW_ADDRESS`, `BRAIN_ONCHAIN_SMART_ACCOUNT`, `BRAIN_SESSION_KEY`, `BASE_RPC_URL`                            |
| Production allowed      | yes                                                                                                                   |
| Audit required          | **yes**                                                                                                               |
| Mainnet boot fence      | `composition/escrow-audit-gate.ts`: throws on boot if `chainId === 8453` && address set && neither `BRAIN_ESCROW_AUDIT_RECEIPT` nor `BRAIN_ESCROW_AUDIT_APPROVED="true"` is set |
| Audit attestation       | Either `BRAIN_ESCROW_AUDIT_RECEIPT` (preferred. URL/filepath/hash pointing at the audit report) or the legacy `BRAIN_ESCROW_AUDIT_APPROVED="true"` boolean. The receipt is preferred because it carries diligence metadata. |
| Failure mode            | `release()` revert → audit-after `ok: false`                                                                          |

### `erp_writeback`

| Attribute               | Value                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Description             | ERP system-of-record writeback                                                       |
| Implementation          | `ErpWritebackStubRail` only; **no real ERP integration exists in MVP**               |
| Chain                   | n/a                                                                                  |
| Required env            | none                                                                                 |
| Production allowed      | **no**. Catalog flag, surfaced in capability log as `production_allowed: false`     |
| Audit required          | n/a                                                                                  |
| Failure mode            | Stub fails closed in `NODE_ENV=production` (item 20). Dev/test no-op acknowledge      |

## How to verify your deploy from logs

After boot, the api emits one structured log line:

```
brain.runtime.capabilities { ... rails: [...] ... }
```

Each rail entry carries:

```json
{
  "name": "escrow_base",
  "live": true,
  "production_allowed": true,
  "required_env_present": true,
  "chain_id": 8453,
  "audit_required": true,
  "audit_approved": "approved"
}
```

A safe production deploy has at least one rail with `live: true`,
`production_allowed: true`, and `required_env_present: true`, and (if
`audit_required: true`) `audit_approved: "approved"`. Anything else is a
configuration smell the release manager must resolve before promotion.

## Adding a new rail

1. Add the rail's implementation in `services/api/src/rails/`.
2. Add a descriptor to `RAIL_CATALOG` in `composition/rail-catalog.ts`. Set
   `productionAllowed`, `requiredEnv`, `evmChain`, `auditRequired` honestly.
3. Wire it into the rail registry in `main.ts` (push to `configured` and
   `liveNames` when env is present).
4. Add a row to this doc following the per-rail table format above.
5. Add a unit test in `rail-catalog.test.ts` that asserts the new row is
   present, posture is computed correctly, and audit gating (if any) matches.

The catalog must be the single source of truth; this doc renders it for
release managers. If you change the catalog without updating this doc the
runtime log will start emitting fields the doc doesn't explain.
