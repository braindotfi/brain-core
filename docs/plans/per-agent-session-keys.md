# Per Agent Session Keys Plan

Status: plan only. No implementation has landed in this branch.

## Goal

Replace the shared `BRAIN_SESSION_KEY` runtime model with one BrainSmartAccount
session key per tenant agent. Each key is scoped by tenant policy, stored in
Azure Key Vault, granted on the tenant BrainSmartAccount, and addressable by
agent id at execution time.

The intended invariant is:

- One BrainSmartAccount per tenant.
- One session-key holder per active on-chain-capable agent within that tenant.
- No raw session private key in environment variables, application databases, or
  logs.
- A disabled agent can be paused or revoked without affecting other agents for
  the tenant.

## Current State

`services/api/src/main.ts` reads `BRAIN_SESSION_KEY`, derives one holder address
with `getHolderAddress`, and passes that holder into on-chain dispatch. That
means all on-chain-capable agents share one holder key when the on-chain rail is
enabled.

`services/api/src/rails/onchainExecutor.ts` signs through
`privateKeyToAccount`. Its header says production uses Azure Key Vault, but the
active implementation still accepts a raw private key. The migration must remove
that path from production use rather than only changing comments.

`contracts/src/BrainSmartAccount.sol` already supports multiple holders with
per-holder grants, nonces, pause state, and window spend. This is the main reason
the feature can be implemented without changing the contract for the base case.

`services/execution/src/rails/session-keys.ts` currently derives one-time
minimum-privilege session key parameters for a payment intent. That per-task
model is deprecated for production. PR B should reuse only its cap-mode
vocabulary, selector choices, and validation posture. It should not create new
short-lived keys for each task.

## Activation Flow

When an agent becomes active for a tenant:

1. Resolve the tenant BrainSmartAccount address and immutable tenant id.
2. Resolve the agent id, agent role, and on-chain permission profile from tenant
   policy.
3. Create a new non-exportable secp256k1 signing key in Azure Key Vault. Use a
   deterministic key name such as
   `brain-{env}-{tenantId}-{agentId}-session-{rotation}` after sanitizing ids.
4. Read the public key from Key Vault and derive the EVM holder address.
5. Build a `BrainSmartAccount.SessionKey` grant from the tenant policy:
   - `holder`: derived Key Vault address.
   - `validAfter`: activation time.
   - `validUntil`: policy expiry or a bounded operational maximum.
   - `allowedTargets`: policy-approved token, recipient, or contract targets.
   - `allowedSelectors`: mode-specific selectors.
   - `capMode`: NATIVE, ERC20, or CALL.
   - `capToken`: token address for ERC20 mode, zero address otherwise.
   - `allowedRecipients`: counterparty addresses for ERC20 mode.
   - `capAmountOffset`, `pinOffset`, and `pinValue`: required for CALL mode.
   - `maxPerTx`, `maxPerPeriod`, and `periodSeconds`: policy limits.
   - `policyVersion`: registered BrainPolicyRegistry hash for the tenant.
6. Submit `grantSessionKey` from the account owner path.
7. Persist non-secret metadata only after the grant transaction is accepted:
   tenant id, agent id, smart account address, holder address, Key Vault key id,
   Key Vault key version, policy version, limits hash, grant transaction hash,
   status, created timestamp, and rotation number.
8. Register the agent rail state as active only after the on-chain readback
   confirms the expected holder and policy version.

If the owner signature cannot be collected immediately, activation should enter
`pending_session_key_grant`. The agent remains propose-only until the grant is
confirmed.

## Azure Key Vault Storage

Session keys must be non-exportable Azure Key Vault keys. The database stores
only lookup metadata:

- `tenant_id`
- `agent_id`
- `smart_account`
- `holder_address`
- `key_vault_key_id`
- `key_vault_key_version`
- `status`
- `grant_tx_hash`
- `policy_version`
- `limits_hash`
- `created_at`
- `rotated_at`
- `revoked_at`

The API and worker use managed identity to request signing from Key Vault. They
never read raw private key bytes. Local development can use a mock signer or an
ephemeral test signer, but production boot must fail if any path tries to use
`BRAIN_SESSION_KEY`.

The existing `OnchainExecutor` interface is already close to the right boundary.
The concrete executor should become a tenant-agent signer resolver:

1. Accept tenant id and agent id with the on-chain action.
2. Resolve the active session metadata row.
3. Create a viem-compatible account or signing adapter backed by Key Vault.
4. Read `nonce(holder)` for the resolved holder.
5. Send `executeViaSessionKey` with the resolved holder signer.

## Owner Key Custody

Per-agent session keys reduce agent blast radius, but they do not remove the
owner key risk. The owner key can grant, revoke, pause, unpause, rotate
ownership, and pause the whole account. It must move away from the deployer key
before production use.

Recommended owner model:

1. Tenant onboarding creates the BrainSmartAccount with a tenant-controlled owner
   address or a custody address assigned to that tenant.
2. Demo and testnet may still use the deployer key, but production must reject a
   BrainSmartAccount whose owner is the deployer address.
3. Production owner control should be a hardware wallet, institutional custody
   account, or threshold signer controlled through an operator runbook.
4. Grant, pause, revoke, and rotation requests should produce an owner-signable
   transaction request. The server must not hold the owner private key.
5. The activation service should treat an unsigned owner transaction as
   `pending_owner_signature`.
6. The system should read back `owner()` before each owner-only transaction and
   fail closed when it does not match the configured custody authority.
7. Owner rotation should use the existing two-step `transferOwnership` and
   `acceptOwnership` path.

Migration away from the deployer key:

1. Inventory every BrainSmartAccount where `owner()` equals the deployer address.
2. For each tenant, choose the target owner custody address.
3. Call `transferOwnership(targetOwner)` from the deployer key.
4. Require the target owner to call `acceptOwnership()`.
5. Verify `owner()` on-chain.
6. Disable the deployer key for future owner actions.
7. Record the rotation in audit with old owner, new owner, tenant id, smart
   account, and transaction hashes.

## Per Agent Limits

Limits should come from the tenant policy authority, not from agent payloads.
The policy layer should produce an on-chain session grant profile with:

- Rail permission: `onchain_transfer`, `x402_settle`, `escrow_release`, or a
  future rail name.
- Settlement asset and token contract.
- Allowed counterparty addresses or contract targets.
- Selector set.
- Per-transaction cap in raw token units or wei.
- Per-period cap in the same units.
- Period length.
- Expiry.
- Registered `policyVersion`.
- Optional pinned argument for CALL mode, such as escrow id or invoice id.

Mapping to `grantSessionKey`:

- NATIVE mode for plain ETH value transfer. Targets are recipient addresses,
  selectors are empty, recipients are empty, and caps meter `msg.value`.
- ERC20 mode for token transfers. Target is exactly the token contract,
  selectors are `transfer` and possibly `transferFrom`, recipients are the
  allowed payees, and caps meter decoded token amount.
- CALL mode for contract calls such as escrow release. Target is the contract,
  selector is exactly one method, `capAmountOffset` identifies the amount word,
  and `pinOffset` plus `pinValue` bind the grant to the object when needed.

`services/execution/src/rails/session-keys.ts` should not be reused to mint
per-payment child grants. For stable per-agent grants, reuse the cap-mode
vocabulary and validation but keep the lifecycle in an agent session-key
service.

## Production Policy To Grant Builder

PR B must add a production policy-to-grant builder. It must read the signed
tenant policy, derive the exact BrainSmartAccount `SessionKey` shape, and reject
any constructor key or post-creation grant that does not match policy exactly.

Required checks:

- The tenant policy is registered in BrainPolicyRegistry.
- Mode, token, targets, selectors, recipients, caps, period, expiry, pin fields,
  and policy version all match the signed tenant policy.
- Constructor initial keys are not accepted from free-form script input.
- Bootstrap caps and expiry are bounded by production onboarding policy.
- Any mismatch fails closed before deployment or grant submission.

## Decision: No Short Lived Per Task Keys

Use one pre-granted session key per tenant agent. Do not create short-lived
per-task keys during normal execution.

Recommendation: keep each per-agent key tightly scoped by policy. Caps,
periods, targets, recipients, selectors, token, mode, expiry, and policy version
must come from signed tenant policy. The backend should reject a task when it
does not fit inside the agent's already active grant instead of creating a new
grant for that task.

Reason: post-creation grants now have a mandatory on-chain delay when they add
authority. Per-task key creation would either block routine execution for 24
hours or pressure the system to create a bypass. Stable per-agent keys preserve
the hard delay while keeping execution practical.

Operational rule: rotations can be prepared ahead of time. A rotation that is
equal or stricter can activate immediately. A broader replacement follows the
on-chain delayed-grant path from PR A.

## Delayed Privilege Increases

Lowering privilege should be immediate. Raising privilege should be delayed.

Immediate actions:

- Pause a holder.
- Revoke a holder.
- Lower `maxPerTx`.
- Lower `maxPerPeriod`.
- Shorten `validUntil`.
- Remove targets, selectors, or recipients.

Delayed actions:

- Raise `maxPerTx`.
- Raise `maxPerPeriod`.
- Extend `validUntil`.
- Add targets, selectors, or recipients.
- Grant a brand new holder for an active agent.

Recommended rule:

1. Treat every privilege increase as a scheduled change with a minimum delay.
2. Use a default delay of 24 hours for production tenants.
3. Allow emergency shortening only through a human break-glass workflow with
   audit severity `critical`.
4. During the delay, keep the current holder and caps active.
5. At execution time, re-read policy and ensure the scheduled change is still
   approved.
6. Lowering, pause, and revoke bypass the delay and execute immediately.
7. Rotation can grant the new holder immediately only when the new grant is equal
   to or stricter than the old grant. A broader rotation must wait out the delay.

The database should store scheduled grant changes separately from active holder
metadata so pending increases cannot be confused with executable authority.

## Approved Decision: On Chain Delay for Increases

PR A, `feat/smart-account-delayed-grants`, adds the 24-hour delay as an
on-chain security control before the external audit. PR B must consume that
contract flow rather than implementing a backend-only waiting period.

The contract change adds:

1. Add pending session-key grants or pending grant changes.
2. Classify a grant as broader, equal, or stricter than the active grant.
3. Apply a delay only to broader grants.
4. Allow immediate stricter grants, pause, and revoke.
5. Add execute or finalize functions after the delay expires.
6. Add events and read methods so the backend can show pending increases.
7. Update grant scripts, TypeScript callers, and contract tests.

Estimated effort for PR A remains 6 to 9 engineering days for the contract,
callers, focused tests, and runbook updates.

Main risks:

- The comparison logic can be wrong and allow a broader grant immediately.
- Delayed grants add contract state and lifecycle complexity.
- Existing grant scripts and activation flows need migration.
- More contract surface area increases audit work.
- Emergency access needs careful design so it cannot become a bypass.

Approved recommendation: add the on-chain delay before the external audit
because the product needs "raising a limit takes time" to be enforced by the
contract, not only by backend services.

## Pause, Revoke, and Rotation

Pause per agent:

1. Resolve the active holder for tenant id and agent id.
2. Call `pauseSessionKey(holder)` from the owner path.
3. Mark the metadata row `paused` after transaction confirmation.
4. Block dispatch for that agent before rail execution.

Revoke per agent:

1. Resolve the active holder.
2. Call `revokeSessionKey(holder)` from the owner path.
3. Mark the metadata row `revoked`.
4. Refuse dispatch until a new active grant exists.

Rotate per agent:

1. Create a new Key Vault key version or a new key name with incremented
   rotation.
2. Derive the new holder address.
3. Grant the new holder on-chain with the current policy limits.
4. Mark the new metadata row `active`.
5. Pause the old holder to stop new execution.
6. Drain or reconcile in-flight outbox items already bound to the old holder.
7. Revoke the old holder after the in-flight window clears.
8. Retain audit links for old holder, new holder, and both transaction hashes.

Rotation must be idempotent. A retry after grant but before database update
should read back the on-chain key and converge instead of granting a duplicate
holder.

## Gas Recommendation

`BrainSmartAccount.executeViaSessionKey` is called directly by the holder, so
the holder pays gas today. A central gas payer would require a relayer or
paymaster style flow where the signer is not the gas payer. That would require a
contract change or a new execution wrapper, and it would expand the external
audit scope.

Recommendation for this phase: fund each per-agent holder with a small gas tank
from a central operations wallet. Add operational controls:

- Minimum balance alert per holder.
- Maximum balance cap per holder.
- Automated top-up only after the session key is active and policy-bound.
- Sweep remaining ETH after pause, revoke, tenant deletion, or rotation.

This keeps the contract unchanged and preserves the direct holder-authenticated
execution model.

## Disable and Tenant Deletion

When an agent is disabled:

1. Pause the session key immediately.
2. Abort or hold new on-chain dispatch for that agent.
3. Let in-flight executions settle only if they were already submitted and
   policy allows them to continue.
4. Revoke the key after the operator-selected grace period.
5. Sweep the holder gas balance.

When a tenant is deleted:

1. Pause all active agent holders for the tenant.
2. Revoke every holder after pause transactions confirm.
3. Sweep gas from every holder where the custody model permits it.
4. Disable Key Vault keys or schedule deletion according to retention policy.
5. Mark metadata rows `tenant_deleted`.
6. Keep audit records, holder addresses, transaction hashes, and non-secret
   metadata for retention.

## Migration From Shared `BRAIN_SESSION_KEY`

1. Add the per-agent metadata table and Key Vault signer resolver.
2. Add a dual-read dispatch path behind a feature flag:
   - Prefer per-agent active holder.
   - Fall back to shared `BRAIN_SESSION_KEY` only for tenants not migrated.
3. Create per-agent keys for pilot tenants and grant them on-chain.
4. Switch those tenants to per-agent-only dispatch.
5. Pause the shared holder for migrated tenants where supported by account
   topology.
6. Revoke the shared holder once every tenant using the account has an active
   per-agent holder.
7. Remove production support for raw `BRAIN_SESSION_KEY`.
8. Keep a test-only signer path for local contract tests.

The migration must include a safety check that one tenant's holder metadata
cannot be used with another tenant's smart account.

## Contract Impact

PR B depends on the BrainSmartAccount and BrainTenantAccountRegistry changes in
PR A. One key per agent uses the existing per-holder model, and broader
post-creation grants must use the delayed-grant flow from PR A.

The contract already has:

- Per-holder session key storage.
- Per-holder nonce.
- Per-holder pause.
- Per-holder revoke.
- Account-wide pause.
- Policy version binding at grant time.

Further contract changes would be needed only if the team chooses central gas
payment, meta-transactions, ERC-4337, batched grants, or on-chain agent ids.
Those changes must be flagged for external audit before mainnet.

## Registry Monitoring And Emergency Cancel

PR B must add monitoring for BrainTenantAccountRegistry events. The monitor
should alert on first assignment, scheduled replacement, cancelled replacement,
activated replacement, owner transfer, and any account whose codehash, tenant id,
owner, or policy registry does not match the tenant onboarding record.

Emergency cancel runbook:

1. Detect an unexpected pending replacement event.
2. Verify the tenant, current account, pending account, executable timestamp,
   transaction hash, caller, and registry owner Safe transaction.
3. Submit `cancelPendingAccountChange(tenantId)` through the registry owner Safe.
4. Confirm the pending replacement is cleared on-chain.
5. Keep all smart-account rails fail-closed for the tenant until the resolver
   verifies the active account again.
6. Record a critical audit event with the detected event and cancel transaction.

## Tests Needed

Contract tests:

- Agent A holder can execute inside its grant.
- Agent B holder cannot execute using agent A grant.
- Agent A holder for tenant A cannot execute on tenant B BrainSmartAccount.
- Paused holder reverts.
- Revoked holder reverts.
- Rotation preserves the old holder window spend and does not reset caps by
  revoke and regrant.

Execution service tests:

- Agent activation creates Key Vault key metadata and submits the correct grant.
- No raw private key is stored in Postgres.
- Production boot rejects `BRAIN_SESSION_KEY`.
- On-chain dispatch resolves holder by tenant id and agent id.
- Dispatch fails closed when metadata is missing, paused, revoked, or tenant
  mismatched.
- Policy limits map to NATIVE, ERC20, and CALL grants correctly.
- Existing `derivePerTaskSessionKey` tests remain green or move under a shared
  grant builder.

Integration tests:

- Two agents in one tenant receive distinct holder addresses.
- Pausing agent A does not pause agent B.
- Tenant deletion pauses and revokes every holder for that tenant.
- Migration tenant uses per-agent holder while non-migrated tenant still uses
  the legacy path during the feature flag window.

Operational tests:

- Key Vault outage fails closed before signing.
- Gas top-up honors minimum and maximum balances.
- Audit events contain tenant id, agent id, holder address, smart account, and
  transaction hash, but no secret material.

## Effort

Estimated implementation effort: 10 to 14 engineering days after plan approval.

- Schema and repository: 1 to 2 days.
- Azure Key Vault signer and local mock signer: 2 to 3 days.
- Activation, grant, pause, revoke, rotation, and delayed increase services:
  3 to 4 days.
- Dispatch integration and migration flag: 1 to 2 days.
- Owner-key custody migration checks: 1 day.
- Tests, docs, and operational runbook: 2 days.

## Risks

- Azure Key Vault secp256k1 support and viem signer compatibility need a proof
  point before implementation is committed.
- Owner-key custody is still the sharp edge. Per-agent keys improve blast radius,
  but `grantSessionKey` remains owner-controlled.
- Delayed privilege increases add state-machine complexity and operator waiting
  periods.
- Direct holder gas means every agent holder needs ETH monitoring.
- Migration must avoid sending live transactions through the old shared holder
  after a tenant is marked migrated.
- Per-agent grants increase operational rows, alerts, and key lifecycle events.
- Any decision to add relayed gas or ERC-4337 changes the audit scope.

## Done and Pending

Done:

- Current shared-key architecture audited at a planning level.
- Existing BrainSmartAccount holder model confirmed to support per-agent keys.
- Existing per-task session-key helper assessed for reuse.
- On-chain delayed grants approved for PR A before PR B implementation.

Pending:

- Wait for PR A delayed-grant and tenant-account-registry changes to merge.
- Implement Azure Key Vault signing adapter.
- Add per-agent session-key metadata table.
- Add production policy-to-grant builder from signed tenant policy.
- Add activation grant service.
- Add pause, revoke, rotate, and tenant deletion flows.
- Add owner-key custody migration checks.
- Add delayed privilege increase scheduling.
- Add registry event monitoring and emergency cancel runbook.
- Route on-chain dispatch by tenant id and agent id.
- Add gas top-up and sweep operations.
- Add migration feature flag.
- Remove production raw `BRAIN_SESSION_KEY` support.
- Add the tests listed above.
