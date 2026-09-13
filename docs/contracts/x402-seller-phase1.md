# x402 seller Phase 1 contract

Status: provider-disabled.

## Fixed protocol

The seller side uses x402 version 2, the `exact` scheme, native USDC, and
CAIP-2 network identifiers. Base Sepolia is `eip155:84532`; the future mainnet
policy is `eip155:8453`. Sepolia USDC is pinned to
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

RobotMoney requires settle-before-fulfillment behavior. The selected strategy
is a low-level Coinbase facilitator adapter that calls verify, then settle,
then independently requires sealed L2 inclusion, and only then calls the
resource handler. Stock authorization middleware is rejected unless a future
version proves that same ordering.

The documentary compatibility witness pins:

- Coinbase's v2 `/settle` request contract, which accepts x402 v2 exact payment
  requirements for Base Sepolia and returns a settlement transaction;
- Coinbase's published Base Sepolia exact EIP-3009 USDC support;
- x402 v2's defined `upfront` settle-before-resource flow.

This proves that the required ordering is representable with the pinned
low-level integration. The operational Phase 2 exit gate still requires an
authenticated `/supported` witness and a real Base Sepolia settlement before
enablement. Phase 1 creates no Coinbase credential or wallet.

## Fixed launch ceiling

All allowlist rows are immutable and disabled. The initial ceiling is:

- API: `listAccounts`, `listTransactions`, `listAuditEvents`;
- MCP: `ledger.accounts.list`, `ledger.transactions.list`,
  `ledger.obligations.list`.

Every operation is read-only. A later immutable revision is required to add an
operation.

## Credentials and replay

`api_keys.credential_class` separates normal included commercial keys from
`x402_pay_per_call`. The pay-per-call class remains within the existing
read-only commercial scope ceiling. Direct `brain_ak_*` values and exchanged
agent JWTs are always rejected from x402 payment authorization.

Each quote has one logical operation, a unique nonce digest, and one unique
payment-payload digest. Nonce consumption is append-only. A fulfilled receipt
must bind a settlement transaction, and one payment digest can back only one
receipt.

## Evidence and retention

Quotes, nonce consumptions, and settlement events are append-only. The receipt
table is the bounded authoritative current-state projection. The endpoints are:

- `GET /v1/x402/receipts/{receipt_id}`;
- `POST /v1/x402/receipts/query`, accepting one through one hundred unique ids.

Neither endpoint reads audit history. Exchanged agent JWTs are rejected.

Tenant-bound logical operations and receipts use `ON DELETE SET NULL` and keep
an irreversible tenant-reference digest. They are explicitly preserved by the
retirement service for seven years. This protects new seller evidence but does
not resolve the older commercial-table deletion conflict, which is designed in
the separate retention proposal.
