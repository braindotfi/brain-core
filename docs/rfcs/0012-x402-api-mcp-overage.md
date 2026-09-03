# RFC 0012. x402 API and MCP usage payments

- **Status:** Implementation in progress. Phase 1 disabled interfaces and
  evidence schema closed on 2026-09-03. No Coinbase credential, payment, or
  activation exists.
- **Date:** 2026-09-03
- **Affects:** API and MCP gateways, standalone and overage calls, RFC 0008
  request metering and entitlements, RobotMoney commercial catalog, USDC
  settlement, Base operations, Coinbase Developer Platform integration,
  customer usage views, and finance reconciliation.
- **Related:** RFC 0001, RFC 0008, RFC 0009, RFC 0011,
  `protocol/m2m-and-x402.md`, `smart-contracts/escrow-and-x402.md`, and
  `docs/rails-matrix.md`.

## 1. Decision summary

API and MCP requests above a tier's included allowance use x402 exact payment
in USDC. Free and Starter may also buy standalone calls through x402 without a
subscription. Stripe does not collect this usage.

Brain acts as the x402 resource server and seller for this use case. This is
the inverse of the existing `x402_base` rail, where Brain acts for a tenant as
the buyer of another service. The existing outbound rail does not implement
RobotMoney overage collection.

The approved settlement model is real-time `exact` on Base mainnet. Each call
blocks until its precise USDC payment is settled. `upto` authorization and
batch settlement are not launch options.

The request handshake is:

1. The request resolves a public operation or is authorized for a private
   tenant resource.
2. Core atomically determines that the included allowance is exhausted.
3. Without valid payment, the resource server returns payment requirements.
4. The client signs a USDC authorization and retries the same logical call.
5. The server verifies and settles the authorization through Coinbase's hosted
   facilitator.
6. After confirmed settlement, the server performs the work and returns the
   result plus settlement evidence.

This is not an asynchronous monthly debt balance. One accepted authorization
maps to one onchain settlement and one commercial operation.

## 2. Protocol baseline

This scope targets x402 v2, not the repository's older illustrative
`X-Payment` header names.

For HTTP, x402 v2 uses:

| Header              | Direction                   | Purpose                                      |
| ------------------- | --------------------------- | -------------------------------------------- |
| `PAYMENT-REQUIRED`  | Brain to client on HTTP 402 | Base64-encoded accepted payment requirements |
| `PAYMENT-SIGNATURE` | Client to Brain on retry    | Base64-encoded signed payment payload        |
| `PAYMENT-RESPONSE`  | Brain to client             | Base64-encoded settlement result             |

The payment requirements name a scheme, CAIP-2 network, amount in atomic token
units, asset contract, recipient address, timeout, and resource. For Base
mainnet the CAIP-2 network is `eip155:8453`; Base Sepolia is `eip155:84532`.

RobotMoney's selected ordering is verify, settle, confirm, then execute. This
follows the requirement to block until paid and prevents delivery of an unpaid
resource. A post-settlement service failure follows the automatic refund policy
in section 9.

## 3. Network and existing Brain infrastructure

Base L2 is aligned with Brain's existing onchain direction:

- The repository defines x402 as USDC on Base.
- The outbound `x402_base` rail targets Base and is represented by chain id
  `8453` in the production rail catalog.
- BrainAuditAnchor and the current reference contracts are deployed on Base
  Sepolia for testing.
- Coinbase's hosted facilitator supports x402 v2 exact settlement on Base
  mainnet and Base Sepolia.

This confirms network compatibility, not production readiness. Overage
payments do not call `BrainAuditAnchor`, and sharing a chain does not make the
anchor publisher wallet, tenant smart accounts, or escrow contract suitable as
the RobotMoney receiving wallet.

Approved production direction and activation progression:

1. Use Base Sepolia and test USDC for protocol and failure-path testing.
2. Provision a dedicated RobotMoney seller wallet under direct RobotMoney
   custody. Do not use a third-party custodian.
3. Complete facilitator, sanctions, KYT, treasury, accounting, key-management,
   and incident-response review.
4. Enable Base mainnet only through a separately approved production gate.

The sandbox receiving address provisioned for review is
`0x5e22088C527e2C112dbe47ceADca94db9Aa19497` on Base Sepolia. It is unfunded,
is not configured in any runtime, has handled no traffic, and requires Damon's
explicit approval before testing. No mainnet wallet was created.

Approved custody mechanics: use a dedicated environment-specific receiving
address backed by an HSM or managed key service, keep the online balance below
a Treasury-approved ceiling, sweep excess USDC daily to a separate treasury
wallet, require two-person approval for destination changes, and never reuse
the tenant spending, escrow, or audit-anchor keys. Direct custody is approved;
the signer technology, balance ceiling, sweep destination, and recovery
runbook are implementation configuration assigned to Damon under the Security
and Treasury responsibility labels.

## 4. Relationship to RFC 0008

### 4.1 Authentication and entitlement happen first

x402 does not replace Brain authentication. Brain needs the authenticated
tenant, key, environment, operation, and catalog revision to determine:

- whether API or MCP access is available on the tier,
- how much included allowance remains,
- whether the requested operation is chargeable,
- which per-call price applies, and
- whether a hold blocks the call entirely. Delinquency alone does not block
  standalone x402 payment.

Free and Starter have no included API or MCP access but may buy standalone
x402 calls. Growth and Scale use x402 after the relevant separate allowance is
exhausted. Enterprise behavior is contract-specific and operator-only.

The payer wallet may remain anonymous and is not linked to a RobotMoney billing
account. That does not remove resource authorization. Approved access split:

- Public non-tenant resources listed in Bazaar may use the valid x402 payment
  as the only caller credential when their data contract permits it.
- Tenant-scoped resources require a normal Growth or Scale credential, or a
  distinct `pay_per_call` credential that identifies tenant, entity, allowed
  operation, and scope but carries no included allowance.
- Downgrading below included-access eligibility revokes broad API and MCP
  credentials. An admin must explicitly issue a pay-per-call credential after
  the downgrade.

Wallet anonymity means no billing-account linkage, not anonymous access to
private tenant data. The distinct credential is approved.

### 4.2 An atomic allowance decision is required

RFC 0008 records durable request facts and closes reconciled periods, but its
post-response meter alone cannot safely decide the last included unit under
concurrency. The later implementation needs an atomic allowance reservation or
consumption decision before the protected handler runs.

Required properties:

- one logical fulfilled operation consumes at most one included unit,
- simultaneous requests cannot all spend the same remaining unit,
- abandoned reservations expire or reconcile deterministically,
- a server failure releases or compensates the reservation under a versioned
  policy,
- an x402-paid call does not also consume included allowance, and
- a tier change does not reset already consumed monthly allowance.

Approved mechanism:

- Maintain separate tenant-wide API and MCP counters for each UTC calendar
  month and immutable catalog revision.
- In one database transaction, create a unique logical-operation reservation
  only when `consumed + reserved < allowance`.
- Give the reservation a five-minute lease. Finalize it only after a successful
  response under the RFC 0008 billable-outcome policy. Release it on a
  definitive failure; an expiry reconciler handles abandoned work.
- Use a unique constraint on tenant, operation class, period, and logical
  operation id so retries return the original reservation or result.
- When allowance is unavailable, do not reserve a unit. Continue to the x402
  exact-payment path.
- A mid-month upgrade changes the ceiling immediately but preserves consumed
  units. A downgrade changes the ceiling without rewriting use and may leave no
  included capacity until the next month.

The tenant-wide scope and five-minute lease are approved. A later reviewed
schema change implements them; this RFC creates no counter or table.

### 4.3 The handshake creates multiple HTTP attempts

The initial HTTP 402 and paid retry are two physical requests but one intended
commercial operation. RFC 0008 should continue recording each attributable
gateway attempt. Commercial usage needs a separate logical-operation identity
that links:

- the initial challenge,
- the quoted catalog and price policy,
- the signed retry,
- facilitator verification,
- handler result,
- settlement result, and
- the one fulfilled API or MCP unit.

The 402 challenge is nonbillable. A settled payment binds to one operation. A
successfully fulfilled operation consumes that payment; a proven service
failure binds the same settlement to its refund. Reports must not count the
challenge and retry as two customer usage units.

## 5. Planned API request flow

RFC 0011 approves $0.01 USDC for one API operation and $0.10 USDC for one MCP
tool call. With six-decimal native USDC, those are 10,000 and 100,000 atomic
units. Each quote references an immutable operation-price policy, accepts only
the allowlisted native USDC contract on `eip155:8453`, and expires after 60
seconds.

For an operation with a fixed per-call price:

1. Authenticate the tenant credential when the resource is private, or resolve
   the public Bazaar operation. Resolve environment, catalog revision,
   operation id, and entitlement version where applicable.
2. Reject demo traffic, held accounts, unauthorized private resources, and
   operations outside the published paid-operation allowlist.
3. Atomically reserve an included unit when one remains.
4. If included, run the handler and finalize the RFC 0008 usage record.
5. If exhausted and no payment payload is present, return HTTP 402 with a
   `PAYMENT-REQUIRED` header.
6. Bind the quote to the stable operation, method, normalized resource,
   catalog revision, price-policy version, optional tenant and entity context,
   asset, network, recipient, amount, and expiry. Do not expose internal tenant
   data in public payment metadata.
7. On retry, authenticate again and verify that the payment payload matches the
   current or still-valid quote. A caller cannot submit a cheaper tier, asset,
   recipient, or operation.
8. Verify through Coinbase's facilitator without running the paid handler.
9. Settle the exact payment and wait for the facilitator's successful Base
   transaction response.
10. Confirm at least sealed L2 block inclusion before running the handler. Do
    not block the hot path for L1 batch finality; recheck it asynchronously.
11. Run the handler under one logical-operation id.
12. Persist fulfillment evidence and return `PAYMENT-RESPONSE` with the same
    transaction reference.
13. Reconcile the fulfilled operation, x402 settlement, and RFC 0008 facts.

Only operations with a fixed immutable exact price are eligible. Dynamic-cost
operations remain unavailable through public x402 until a future approved
fixed-price envelope exists. `upto` is not a launch fallback.

## 6. Planned MCP request flow

MCP access uses the same entitlement and commercial operation ids as HTTP API
access. The approved launch transport is MCP Streamable HTTP backed by the same
paid HTTP resource adapter used by the API gateway:

1. The MCP POST identifies the stable tool name and authenticates any required
   tenant-scoped credential.
2. The gateway performs the separate MCP allowance reservation.
3. When payment is required, the HTTP response carries the standard x402 v2
   402 headers. No proprietary payment fields are added to JSON-RPC.
4. An x402-capable client retries the identical logical tool call with
   `PAYMENT-SIGNATURE`.
5. The gateway verifies and settles before invoking the MCP tool, then returns
   the normal JSON-RPC result with `PAYMENT-RESPONSE` on the HTTP response.
6. A client that cannot perform the retry receives a stable JSON-RPC error with
   an actionable client-capability message in addition to the HTTP 402.

The following remain invariant:

- API and MCP allowance categories are separate.
- The tool name maps to a stable commercial operation id.
- Private-resource authorization and applicable tier eligibility precede
  payment.
- The client explicitly supports x402 and can sign USDC authorizations.
- A non-x402-capable client receives an actionable error, not an endless retry.
- The same payment authorization cannot buy multiple tool calls.
- Tool failure, cancellation, timeout, and streaming responses have defined
  settlement behavior.

Approved launch support is limited to Streamable HTTP clients that preserve
HTTP response headers and can use the x402 TypeScript, Python, or Go payment
client. Stdio-only clients require a local bridge that performs the paid HTTP
call and holds the user's wallet. Direct stdio payment metadata is out of scope.

The exact supported-client matrix must be proven in a compatibility test before
publication in Bazaar. Advertising MCP access without a supported retry path
would strand customers after the included allowance is exhausted.

## 7. Facilitator and settlement model

Use Coinbase Developer Platform's hosted facilitator for launch. A facilitator
can verify signed payloads, screen transactions, submit settlement, sponsor
gas, and return transaction evidence. The resource server still owns
authorization, pricing, fulfillment, idempotency, refunds, and accounting.

Scheme decision:

| Scheme             | Fit                     | Main consequence                                                       |
| ------------------ | ----------------------- | ---------------------------------------------------------------------- |
| `exact`            | Approved launch scheme  | One accepted payment creates one onchain settlement                    |
| `upto`             | Not approved for launch | Dynamic actual-cost calculation conflicts with fixed exact prices      |
| `batch-settlement` | Not approved for launch | Delayed redemption conflicts with literal real-time onchain settlement |

Approved provider controls:

- Pin the CDP facilitator URL and x402 v2 exact EVM scheme per environment.
- Do not silently fail over to a different facilitator or self-settlement path.
- Treat verification and settlement timeouts as unavailable service, never free
  access.
- Validate production quota, service terms, incident contacts, and expected
  transaction cost before activation. CDP currently publishes 1,000 free
  transactions per month and $0.001 for each additional transaction; the
  commercial model must tolerate provider changes.
- Reconcile the facilitator transaction hash against an independent Base RPC
  source rather than trusting one provider as both submitter and sole evidence.

The facilitator's built-in KYT and sanctions screening is useful defense in
depth. It does not by itself answer RobotMoney's customer KYB, launch-country,
tax, treasury, or sanctions obligations.

## 8. Planned evidence and reconciliation

Subject to later schema review, each logical x402 overage operation needs:

- stable operation and idempotency ids,
- tenant, billing account, key, entity, and environment when applicable,
- API operation id or MCP tool id,
- catalog, allowance, metering, and price-policy versions,
- quote amount, atomic units, asset contract, network, recipient, and expiry,
- a digest of the payment requirements and payload, not private key material,
- payer address and facilitator verification result,
- handler completion status,
- settlement status, transaction hash, and network,
- refund or compensating transfer reference when applicable,
- linked RFC 0008 request ids, and
- created, verified, fulfilled, settled, and reconciled timestamps.

Approved retention:

- Never place the full payment header in application logs, traces, or
  analytics.
- Keep the full signed payload only in encrypted transient processing storage
  for at most 24 hours, then retain only its digest and authorization nonce.
- Keep quotes, payload digests, nonces, logical-operation links, and failure
  codes for 13 months.
- Keep payer address, settlement transaction, amount, asset, network, refund,
  and accounting evidence for seven years.
- Keep ordinary diagnostic logs for 30 days and security-abuse aggregates for
  90 days.

The retention periods are approved. Compliance-owned constraints enter as
deployment configuration and may shorten or extend them before production
activation without changing the evidence contract.

Reconciliation checks:

- every settled payment maps to at most one fulfilled operation,
- every paid fulfilled operation maps to exactly one approved exact settlement,
- no included call also has a customer-funded x402 settlement,
- asset, network, recipient, and amount match the signed quote,
- the onchain receipt reaches the required finality,
- retries return or reference the existing outcome instead of charging again,
  and
- refunds and reversals are visible as new compensating evidence.

## 9. Failure, refund, and replay policy

Required fail-closed cases include malformed payment data, stale quotes,
wrong asset, wrong network, wrong recipient, insufficient authorization,
invalid signature, reused authorization, facilitator verification failure,
unsupported client version, held account, and unavailable commercial policy.

Approved failure policy:

- Verification or settlement failure runs no handler and creates no customer
  charge. Return an actionable 402 or 503 with a retryable classification.
- Settlement succeeds before the handler starts. If the handler returns a Core
  5xx, its dependency fails, the server cancels before producing a durable
  result, or the operation exceeds its published timeout, mark a proven service
  failure and automatically queue a full USDC refund.
- A client-side disconnect after handler start is not by itself a proven
  service failure. Store the result under the logical-operation id so a retry
  can retrieve it without another charge.
- A semantically valid 2xx or 3xx result is fulfilled. Auth, scope, validation,
  policy, and rate-limit 4xx outcomes are checked before payment and are never
  charged. A paid operation that later returns one of those statuses is an
  implementation defect and receives an automatic refund.
- If settlement succeeds but independent receipt confirmation disappears due
  to a reorganization, pause new paid fulfillment, reconcile the transaction,
  and either resume after inclusion or require a fresh authorization. Never
  charge twice for the same logical operation.
- Streaming paid operations buffer until settlement and do not expose billable
  output before confirmation. A stream that fails before its documented
  completion marker receives a full refund.
- Refunds use a separate RobotMoney treasury transaction back to the original
  payer address, reference the original settlement, and require no billing
  account linkage. Automatic policy-qualified refunds need no operator action;
  exceptional disputes remain operator-approved.
- A customer may open a dispute within 30 days of settlement. Required evidence
  is the transaction hash, logical-operation id or quote digest, timestamp, and
  claimed failure. Server traces, durable handler outcome, response digest,
  dependency status, and retry history determine the result.
- Approved refunds are submitted within two business days. Onchain gas and
  token price movement are borne by RobotMoney; the customer receives the
  original USDC amount.

Idempotency must bind the signed authorization to one logical operation and
return the prior result when safe. A fresh retry key must not bypass replay
protection or generate another charge for the same fulfilled operation.

The 30-day dispute window, two-business-day refund target, automatic failure
classes, and streaming rule are approved.

## 10. Security, compliance, and operational boundaries

- The RobotMoney receiving wallet is separate from tenant spending wallets and
  the audit-anchor publisher wallet.
- CDP credentials, wallet signing material, and facilitator secrets remain in
  environment-scoped secret storage with rotation and least privilege.
- The resource server never accepts a client-provided price, recipient, asset,
  catalog revision, or entitlement decision.
- Mainnet enablement requires supported-country, KYB-trigger, KYT, sanctions,
  tax, stablecoin accounting, treasury, refund, and incident-response approval.
- USDC depeg, token-contract, network-halt, facilitator-outage, and wallet-loss
  procedures need explicit runbooks.
- A facilitator outage does not silently turn an overage call into free usage.
- Mainnet and testnet asset addresses and CAIP-2 identifiers are allowlisted and
  environment-fenced.
- Customer-visible receipts state the USDC amount, network, operation, and
  settlement result without exposing internal risk signals.
- Paid public endpoints are published through x402 Bazaar with stable operation
  ids, exact prices, asset, network, and descriptions. Tenant-private routes do
  not expose tenant identifiers or data through discovery metadata.

Approved abuse controls:

- At most 30 unpaid 402 challenges per minute and 300 per hour per authenticated
  credential or public caller fingerprint.
- At most five invalid payment verifications per minute and 20 per hour per
  credential, payer address, and privacy-preserving IP fingerprint.
- Exponential backoff begins after the fifth invalid verification. Repeated
  signature, replay, recipient, asset, or network failures trigger a 15-minute
  block and security event.
- Valid settled calls remain subject to the published RFC 0008 request-rate
  ceiling. Payment never buys denial-of-service capacity.

These thresholds are approved launch defaults and must be load-tested before
production activation.

Compliance-owned launch countries, KYB trigger criteria, tax registrations,
merchant entity, and Stripe Tax setup are not scoped here. RFC 0012 exposes
activation gates for the approved outputs of Damon's separate track.

## 11. Approved implementation decisions

- Use the approved public allowances and exact prices in RFC 0011.
- Use native six-decimal USDC, immutable operation-price policies, and a
  60-second quote expiry.
- Use a distinct no-allowance pay-per-call credential for tenant-private Free,
  Starter, and downgraded access. Public resources may be wallet-paid without a
  tenant credential.
- Settle through Coinbase's hosted facilitator with no silent provider fallback.
- Require successful facilitator settlement plus sealed Base L2 block inclusion
  before fulfillment. Recheck L1 batch inclusion asynchronously.
- Use the HSM or managed-key direct-custody and daily-sweep model in section 3.
- Use the five-minute transactional allowance reservation in section 4.2.
- Use Streamable HTTP with standard x402 headers and the client support boundary
  in section 6.
- Use the service-failure, refund, evidence, and dispute policy in section 9.
- Use the 24-hour, 30-day, 90-day, 13-month, and seven-year retention classes in
  section 8.
- Use the unpaid-challenge and invalid-payment limits in section 10.
- Publish public paid endpoints in Bazaar while excluding tenant-private
  metadata.
- Damon currently owns the Finance Controller, Billing Engineering, Treasury,
  Security, Product, client surface, Core, and Platform responsibility labels
  from RFC 0009. Each action records its label and authenticated actor so later
  delegation changes assignments without changing evidence or workflows.
- The initial assignment uses authenticated actor
  `user_01M0NTPB2292Z4BF5BHVEM41C6`.

Base mainnet, exact settlement, unlinked payer wallets, direct RobotMoney
custody, Free and Starter standalone access, delinquent-tenant access, and
Bazaar discovery and every mechanic above are approved decisions.

## 12. x402 workstream checkpoints

### Checkpoint A. Protocol contract and disabled foundation

- Approve the later schema and OpenAPI changes separately.
- Add immutable operation prices, logical-operation identity, exact-payment
  verification, responsibility labels, evidence retention classes, and all
  feature gates without production credentials.
- Keep every x402 path disabled in production.

### Checkpoint B. Base Sepolia sandbox

- Integrate Coinbase's facilitator on Base Sepolia with test USDC.
- Exercise API and MCP exact settlement, standalone pay-per-call credentials,
  allowance reservations, retries, replay defense, timeouts, and automatic
  refunds.
- Test direct-custody key rotation, sweep simulation, and independent receipt
  reconciliation without production funds.

### Checkpoint C. Settlement shadow

- Run allowance decisions, quotes, and expected settlement records against
  production-shaped traffic without returning 402 or moving money.
- Compare RFC 0008 request facts, logical operations, expected USDC amounts,
  facilitator simulations, and customer-visible usage daily.
- Continue for at least 14 days and until the last-unit concurrency, replay,
  lost-response, and refund test suites have no unexplained difference.

### Checkpoint D. Internal Base mainnet canary

- Enable exact mainnet settlement only for RobotMoney-owned callers and a
  tightly allowlisted operation set.
- Cap individual calls at $0.10 USDC and total canary exposure at $100 USDC per
  day even if catalog prices would permit more.
- Require at least seven days and 1,000 successful paid operations, whichever
  is later, with daily independent chain reconciliation and successful refund
  drills.
- Keep Bazaar discovery disabled.

### Checkpoint E. Limited customer canary

- Admit a small allowlisted customer cohort with published catalog prices,
  normal allowance behavior, pay-per-call credentials, and MCP clients from the
  verified compatibility matrix.
- Keep per-tenant and global emergency caps, daily reconciliation, automatic
  refunds, and facilitator-outage fail-closed behavior enabled.

### Checkpoint F. General availability

- Publish eligible public API and MCP operations through Bazaar only after the
  limited cohort exits successfully.
- Remove temporary canary caps only through a separately reviewed production
  activation runbook.
- Preserve ongoing independent chain reconciliation, refund monitoring, and
  periodic custody drills.

Phase 1 adds only disabled interfaces and evidence tables. No dependency,
facilitator implementation, credential, wallet signer, payment, or environment
activation is authorized. Phases 6 and 7 of RFC 0011 govern sandbox and
mainnet activation.

## 13. Required validation for a later implementation

- The last included unit cannot be consumed by multiple concurrent calls.
- The first 402 attempt and paid retry count as one fulfilled commercial unit.
- A 402 challenge alone never creates a charge.
- Wrong tenant, key, operation, price, asset, network, or recipient fails
  closed.
- Replayed payment authorization cannot fulfill or charge another call.
- A lost response and retry cannot double-charge a completed operation.
- Included and x402-paid paths cannot both charge the same call.
- Every paid success reconciles to facilitator and chain evidence.
- Handler, facilitator, and chain failures follow the approved charge or refund
  policy.
- Free, Starter, demo, held, and delinquent behavior matches the published
  eligibility policy.
- API and MCP reports preserve their separate allowance semantics.
- No wallet key, CDP secret, full payment header, or unrelated tenant data
  reaches logs, traces, or client analytics.
- Mainnet cannot boot with testnet identifiers or an unapproved receiving
  wallet.
- A Core or dependency failure after settlement automatically produces one
  traceable refund for the original USDC amount.
- Public Bazaar metadata contains no tenant-private identifier or data.
- Standard typecheck, test, lint, invariants, row-level-security, OpenAPI, SDK,
  migration, and no-em-dashes checks pass when implementation begins.

## 14. Primary references

- [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
- [Coinbase explanation of the x402 flow](https://docs.cdp.coinbase.com/x402/how-it-works)
- [x402 HTTP 402 and v2 headers](https://docs.x402.org/core-concepts/http-402)
- [Coinbase CDP facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator)
- [Coinbase facilitator pricing and responsibilities](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)
- [Coinbase x402 settlement API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/settle-payment)
- [x402 seller quickstart and payment schemes](https://docs.x402.org/getting-started/quickstart-for-sellers)
- [x402 network and token support](https://docs.x402.org/core-concepts/network-and-token-support)
- [x402 MCP server guide](https://docs.x402.org/guides/mcp-server-with-x402)
- [x402 Bazaar extension](https://docs.x402.org/extensions/overview)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Base transaction finality](https://docs.base.org/base-chain/network-information/transaction-finality)
- [Coinbase x402 v1 to v2 migration](https://docs.cdp.coinbase.com/x402/migration-guide)
