# RFC 0012 Phase 2: seller custody and Coinbase adapter

Status: Key Vault Premium bootstrap implementation ready, external activation
pending two-person approval and witnessed restore drill

## Safety state

This phase does not enable an x402 operation. The six Phase 1 allowlist rows
remain disabled. Mainnet remains unsupported. No vault, HSM-backed key, wallet,
Coinbase credential, test tenant, or funding is created by merging this code.

The old RFC 0008 receiver
`0x5e22088C527e2C112dbe47ceADca94db9Aa19497` remains
`rfc0008_test_receiver_retired`, with both receive and sign authorization set
to false. It must never be funded or authorized.

## Testnet custody bootstrap

Base Sepolia piloting uses Azure Key Vault Premium rather than Azure Managed
HSM. Premium uses shared Azure HSM infrastructure but still generates a
non-exportable HSM-backed key. This is a testnet cost decision, not approval of
Premium custody for real money.

The isolated `infra/x402-key-vault-bootstrap` root creates:

1. A dedicated resource group and virtual network in Canada Central.
2. A private Premium source vault with purge protection and 90-day soft delete.
3. A private Premium restore-drill vault in the same subscription and
   geography, also with purge protection and 90-day soft delete.
4. An Azure-generated, non-exportable `EC-HSM` `P-256K` seller key whose only
   key operation is `sign`.
5. A dedicated `brain-x402-treasury-signer` managed identity.
6. One custom data action, `Microsoft.KeyVault/vaults/keys/sign/action`,
   assigned to that identity at the exact seller-key resource scope.
7. Private endpoints, private DNS, 90-day Log Analytics retention, two-human
   alert delivery, control-plane change alerts, key-lifecycle alerts, and
   failed or anomalous signing alerts.

The runtime identity receives no create, import, export, backup, restore,
delete, purge, rotate, encrypt, decrypt, wrap, unwrap, role, vault, or network
permission. The source address is permanently classified
`x402_sepolia_bootstrap_only`.

The key is created through the Key Vault ARM resource provider, not through a
runner-to-vault data-plane connection. The isolated plan and apply therefore do
not require the paused Container Apps stack or its ACR. The existing Terraform
state account remains the only data-plane dependency for the hosted OIDC
runner. The restore drill later requires short-lived private-network execution,
but can use Microsoft's public Azure CLI image in the dedicated delegated
subnet. It does not resurrect the production Container Apps stack.

## Two-person administrative control

The former Managed HSM security-domain recovery ceremony does not apply to Key
Vault Premium. Azure controls Premium-vault service recovery. The equivalent
human control is administrative dual approval around every sensitive change.

Any apply crosses two sequential protected GitHub environments:

- Treasury: Damon, GitHub `damonnam`, is the only required reviewer.
- Security: Sanket, GitHub `sanketdebnath24`, is the only required reviewer.

The workflow verifies each environment's sole reviewer identity and user ID
immediately before Azure login. The reviewer sets are disjoint, so a single
reviewer cannot satisfy both gates. Self-review prevention is not required
because either of the two operators must be able to dispatch the workflow and
approve their own distinct gate. The other person's separate approval remains
mandatory. The apply also requires an exact main SHA, a retained exact Terraform
plan, and the confirmation
`APPLY-X402-SEPOLIA-KEY-VAULT-BOOTSTRAP`.

The same dual approval is required before temporary drill permissions, key
disablement, new versions, recovery, backup, restore, network changes, role
changes, or destination changes. Permanent runtime permissions remain sign
only. MFA and PIM remain required for Azure administrative identities.

## Witnessed restore drill

Damon and Sanket jointly witness
`scripts/ops/x402-key-vault-restore-drill.mjs` from a short-lived private-network
operator. Temporary source backup and restore-vault restore, read, and sign
permissions are granted only for the drill and removed immediately afterward.

The operator writes the protected backup blob to a mode-0600 temporary
directory and removes it on every exit path. It restores the seller key into
the isolated Premium vault, then verifies:

- both vaults are Premium and in the same subscription and geography;
- source and restored keys are `EC-HSM`, curve `P-256K`, enabled, and sign only;
- public-key fingerprints match;
- the derived checksummed EVM addresses match;
- source and restored keys both sign the fixed challenge;
- both signatures verify against their public keys.

The receipt excludes the backup blob, tokens, and private material. It records
the public fingerprint, derived address, fixed-challenge digest, resource IDs,
verification booleans, witnesses, and UTC completion time. A failed drill keeps
x402 payments disabled.

## Testnet and mainnet technical gates

Premium-vault custody is accepted only when all of these are true:

- chain id is exactly `84532`;
- the exact versioned key URI ends in `.vault.azure.net`;
- the address classification is `x402_sepolia_bootstrap_only`.

A Key Vault URI is rejected for chain id `8453`. Any future Base mainnet key URI
must end in `.managedhsm.azure.net`. Mainnet additionally requires a genuinely
new Managed HSM-generated key and wallet, at least three real and distinct
recovery holders, a full security-domain ceremony, a witnessed backup and
restore receipt, and full custody reapproval. The Premium key and address are
never migrated to mainnet. No waiver can bypass this gate.

## Signing policy

Key RBAC limits the identity to one key and the `sign` operation. It cannot
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

These are not commercial-included API keys. Presenting one to ordinary resource
authorization is rejected. Agent API keys and exchanged agent JWTs are never
eligible for x402 payment authorization.

## Counterfactual sandbox

Counterfactual observations use `x402_counterfactual_observations`, not the RFC
0008 or RFC 0011 shadow tenant or tables. The table is append-only and retains
evidence for seven years. When route execution is introduced, a dedicated
internal x402 sandbox tenant must receive its own immutable commercial billing
exclusion before the first request. It must never share the commercial shadow
tenant or credentials.

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

## External activation gates

Before apply, the two protected approval environments, OIDC identity, expected
subscription, Terraform state access, alert recipients, and private network
plan must be verified. Before any signing test, the witnessed restore receipt,
temporary-role cleanup evidence, Coinbase CDP test credential, official status
subscription, fresh authenticated support witness, seller address, billing
excluded sandbox tenant, and test USDC funding must all exist. Merging this
implementation performs none of those external actions.
