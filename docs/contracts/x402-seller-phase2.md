# RFC 0012 Phase 2: seller custody and Coinbase adapter

Status: implementation ready, external activation pending witnessed ceremony

## Safety state

This phase does not enable an x402 operation. The six Phase 1 allowlist rows
remain disabled. Mainnet remains unsupported. The old RFC 0008 receiver
`0x5e22088C527e2C112dbe47ceADca94db9Aa19497` is recorded as
`rfc0008_test_receiver_retired`, with both receive and sign authorization set
to false. It must never be funded or authorized.

## Custody checkpoints

The production Terraform stack creates these resources before activation:

1. A private Azure Key Vault Managed HSM with purge protection.
2. A dedicated `brain-x402-treasury-signer` managed identity.
3. A private GRS recovery storage account with a seven-year immutable
   security-domain container and infrastructure encryption.
4. A separate private GRS backup storage account named
   `brainx402backupprod`, with versioning and infrastructure encryption.
5. A private `managed-hsm-full-backups` container without an immutability
   policy, because Azure Managed HSM full backup rejects immutable storage.
6. A dedicated `brain-x402-hsm-backup` managed identity scoped to Storage Blob
   Data Contributor on that dedicated backup account only.
7. Private endpoint and private DNS connectivity for both the HSM and backup
   storage.

The backup identity receives only `backup/start` and `backup/status` inside
the HSM after activation. It receives no restore, key, role, security-domain,
sign, or other cryptographic permission. Azure's trusted-service storage
bypass is enabled because Managed HSM performs backup as an Azure service. No
shared storage key or public network path is permitted.

The first apply leaves the HSM inactive and does not create a seller key. HSM
activation is a separate observed ceremony involving exactly two retained
recovery holders:

- Holder A: Damon
- Holder B: Sanket

Azure requires at least three recovery certificates and permits a minimum
quorum of two. The ceremony therefore uses certificates A, B, and transient C
with quorum two. A and B remain under their respective holders' exclusive
offline control. C exists only through the restore drill and its private key is
then permanently destroyed with both holders witnessing. Only C's public
certificate and fingerprint remain. This is an effective two-of-two recovery
arrangement inside Azure's three-certificate, quorum-two envelope.

The encrypted security domain is transferred directly to the immutable GRS
recovery container. A full HSM backup is written only to the separate
backup-compatible GRS container. No recovery private key may enter a repo, CI
secret, Azure Key Vault, terminal log, cloud drive, password manager, or
ticket.

After Azure confirms activation during the witnessed ceremony,
`x402_hsm_activated` is changed to true for a reviewed ceremony-only Terraform
apply. That apply creates the backup-only HSM role and exactly one
non-exportable `EC-HSM` `P-256K` key with only the `sign` key operation. It does
not enable x402 payments. The treasury signer receives only
`Microsoft.KeyVault/managedHsm/keys/sign/action`, scoped to that key.

The ceremony then takes a full backup and must prove an A+B recovery into an
isolated drill HSM before C is destroyed. The restored seller key must have the
same public-key fingerprint and derived Base Sepolia address, remain
non-exportable, and complete a fixed signing challenge. A failed backup or
restore stops all later activation work and leaves x402 payments disabled.

This custody model is Base Sepolia-only and is never sufficient for mainnet.
Mainnet requires full custody reapproval, at least three real and distinct
recovery holders, a newly wrapped security domain, and a witnessed restore
drill. No waiver or risk acceptance may override that requirement.

## Signing policy

HSM RBAC limits the identity to one key and the `sign` operation. It cannot
inspect a transaction digest. The signer service therefore accepts only typed
treasury intents and constructs the transaction internally. It rejects raw
transactions, raw calldata, contract deployment, request-supplied destinations,
and all networks except Base Sepolia.

Allowed signatures are limited to:

- Pinned Base Sepolia USDC at
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- A sweep to the currently approved checksummed destination.
- A refund to the original payer for exactly the original settled amount and
  bound to the durable receipt.

The operational ceiling is 1,000 test USDC. The operator sweeps at 500 test
USDC or once per UTC day, whichever happens first.

## Destination changes

A destination change is append-only and requires two different humans: one
Treasury approver and one Security approver. The address must be checksummed.
The exact confirmation is
`APPROVE_X402_SWEEP_DESTINATION_CHANGE_NO_BYPASS`. A test transfer receipt is
mandatory. A future mainnet change has a 24-hour delay from the later approval.
There is no bypass path.

The GitHub environments `x402-treasury-approval` and
`x402-security-approval` must have disjoint reviewer memberships before the
destination operator can be used.

## Coinbase CDP adapter

The adapter is pinned to
`https://api.cdp.coinbase.com/platform/v2/x402`. It obtains short-lived request
JWTs through an injected token provider. Tokens and response bodies never
appear in errors or durable evidence. A rolling admission gate permits at most
20 logical operations per second. Verify and settle calls for the same logical
operation share one admission.

Immediately before every settlement acceptance run, the operator performs an
authenticated `GET /supported`. It stores a SHA-256 response digest and a
bounded fifteen-minute witness proving x402 v2, exact, and Base Sepolia support.
The pinned USDC address is then proved by the real settlement itself.

The scheduled status check consumes Coinbase's official Statuspage summary and
fails visibly unless the Coinbase Developer Platform component is operational.
An incident records the request id, UTC timestamps, affected endpoint, network,
and HTTP status before opening a CDP Support case. Credentials and payment
payloads are excluded.

## Pay-per-call credentials

Pay-per-call keys are stored in `api_keys` with
`credential_class='x402_pay_per_call'`. The database stores only the existing
peppered SHA-256 digest. Plaintext is returned once.

- Sandbox prefix: `brain_xk_test_`, maximum lifetime 30 days.
- Live prefix: `brain_xk_live_`, maximum lifetime 90 days.
- Rotation overlap: zero through 24 hours, never longer.

An immutable grant row binds each credential to a subset of exactly these six
operations:

- API `listAccounts`
- API `listTransactions`
- API `listAuditEvents`
- MCP `ledger.accounts.list`
- MCP `ledger.transactions.list`
- MCP `ledger.obligations.list`

The credentials are not ordinary commercial-included API keys. Presenting one
to the ordinary resource authorization path is rejected. Agent API keys and
exchanged agent JWTs are never eligible for x402 payment authorization.

## Counterfactual sandbox

Counterfactual observations use `x402_counterfactual_observations`, not the RFC
0008 or RFC 0011 shadow tenant or tables. The table is append-only and retains
evidence for seven years. When route execution is introduced, a dedicated
internal x402 sandbox tenant must be created with its own immutable commercial
billing exclusion before the first request. It must never share the commercial
shadow tenant or credentials.

## Settlement order

The only accepted order is:

1. Authenticate.
2. Atomically reserve allowance for five minutes.
3. Create a quote.
4. Verify with Coinbase CDP.
5. Settle with Coinbase CDP.
6. Confirm the transaction independently through Base RPC.
7. Require sealed L2 inclusion.
8. Execute the handler.
9. Persist fulfillment, or queue a matching-amount refund if the handler fails.

Stock authorization middleware remains rejected because it cannot prove this
ordering. The low-level adapter is required.

## External apply gates

Before the custody foundation is applied, review must confirm the Azure SKU and
cost, Damon and Sanket as the retained recovery holders, the transient-C
destruction procedure, and the two disjoint destination reviewer groups. Before
activation, the ceremony runbook, immutable security-domain destination,
backup-compatible destination, PIM, MFA, and alerts must be verified. Before a
settlement test, the witnessed A+B restore receipt, C destruction receipt,
Coinbase CDP test credential, official status subscription, fresh authenticated
support witness, seller address, billing-excluded sandbox tenant, and test USDC
funding must all exist.
