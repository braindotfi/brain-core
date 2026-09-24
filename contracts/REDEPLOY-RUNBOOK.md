# Contracts redeploy runbook (audit remediation)

Every contract in `contracts/src` changed. Contracts are immutable, so this is a
**redeploy plus re-registration**, not an upgrade. The existing contracts are currently live on
Base Sepolia and referenced from `.env`, so the old addresses keep working until
you cut over; nothing here is destructive to existing state.

Nothing in this change broadcasts a transaction. This document is the operator
half, to be run deliberately.

## What breaks if you deploy in the wrong order

`BrainSmartAccount.grantSessionKey` now VERIFIES that a key's `policyVersion` is
a hash the tenant actually registered, by calling
`BrainPolicyRegistry.isRegisteredHash(tenantId, policyHash)`. The registry
address is checked for non-zero at construction and the call is not optional.

So the order is forced:

1. `BrainPolicyRegistry`
2. bootstrap a tenant signer, then `registerPolicy` for each tenant
3. `BrainSmartAccount` (constructed with that registry address and any initial
   session keys)
4. `BrainTenantAccountRegistry`
5. `assignAccount` in `BrainTenantAccountRegistry`
6. `grantSessionKey` for keys added after creation

Deploying the account first, or against a registry with no policy registered for
its tenant, leaves an account that cannot grant any session key.

`script/DeployOnchainDemo.s.sol` registers the policy, then constructs the
account with an initial key so the demo holder is active immediately. The
initial key uses script constants for mode, caps, expiry, and policyVersion.
Only the recipient comes from the environment. Those constants mirror the signed
demo policy digest registered before account construction.

## Deploy order

| Order | Contract                  | Constructor arg                          | Depends on                 |
| ----- | ------------------------- | ---------------------------------------- | -------------------------- |
| 1     | `BrainPolicyRegistry`     | `admin` (bootstrap admin, now rotatable) | none                       |
| 2     | `BrainMCPAgentRegistry`   | `admin`                                  | none                       |
| 3     | `BrainAuditAnchor`        | `publisher` (Safe multi-sig in prod)     | none                       |
| 4     | `BrainReputationRegistry` | `attestor`                               | none                       |
| 5     | `BrainEscrow`             | `arbiter`                                | none                       |
| 6     | `BrainSmartAccount`       | `owner`, `tenantId`, `policyRegistry`, `initialSessionKeys` | 1, and a registered policy |
| 7     | `BrainTenantAccountRegistry` | `owner`                                  | none                       |

`BrainSignatureChecker` is a library with only `internal` functions, so it is
inlined into both registries. There is nothing separate to deploy or link.

## Address rotation

Update these in `.env` (and the deployed environments' env files) after each
deploy. `.env.example` and `.env.prod.example` list the same names.

```
POLICY_REGISTRY_ADDRESS
MCP_AGENT_REGISTRY_ADDRESS
AUDIT_ANCHOR_ADDRESS
BRAIN_REPUTATION_REGISTRY_ADDRESS
BRAIN_ESCROW_ADDRESS
BRAIN_ONCHAIN_SMART_ACCOUNT
BRAIN_TENANT_ACCOUNT_REGISTRY_ADDRESS
BRAIN_SMART_ACCOUNT_CODEHASH
```

`BRAIN_ONCHAIN_SMART_ACCOUNT` remains a compatibility fallback. Production
on-chain dispatch must resolve the tenant account from
`BRAIN_TENANT_ACCOUNT_REGISTRY_ADDRESS` and verify `BRAIN_SMART_ACCOUNT_CODEHASH`
plus `tenantId()` before use.

`BRAIN_X402_USDC_ADDRESS` is now required for gate check 6.6 to run at all. The
escrow resolver is wired only when BOTH `BRAIN_ESCROW_ADDRESS` and
`BRAIN_X402_USDC_ADDRESS` are set, so a half-configured escrow leaves the check
dormant rather than running it without an asset binding. Confirm it is set
wherever the escrow address is.

Also reset `AUDIT_ANCHOR_FROM_BLOCK` to the new anchor contract's deploy block.
Leaving the old value makes the broadcaster and reconciler scan a range that
predates the contract.

## Re-registration (on-chain state does not migrate)

Storage does not carry across a redeploy. For each tenant, in order:

1. **Policy registry signers.** `setTenantSigner` with the bootstrap admin for
   the first signer, then existing signers for the rest.
2. **Threshold (new).** `setTenantThreshold` if the tenant wants M-of-N.
   Unset reads as 1, so existing single-signer tenants keep working untouched.
   A signer removal that would drop the tenant below its own threshold is
   rejected rather than stranding it.
3. **Policies.** `registerPolicy` for every policy version a live session key or
   audit reference depends on. Version 0 is now rejected; start at 1.
4. **Agent registry signers**, same bootstrap path as step 1.
5. **Agents.** `registerAgent` for every agent. Use
   `scripts/ops/register-prod-agent.ts` (dry-run by default, `--broadcast` to
   send). Its ABI and call site are already updated for the new `authSigner`
   parameter.
6. **Tenant account registry.** Assign the tenant's BrainSmartAccount in
   `BrainTenantAccountRegistry`. The first assignment is active immediately.
   Replacing an existing account waits `ACCOUNT_CHANGE_DELAY`, can be cancelled,
   and then requires `activatePendingAccountChange(tenantId)`.
7. **Session keys.** For new customer accounts, pass the first session keys in
   the `BrainSmartAccount` constructor. Those keys are active immediately and
   this path exists only at creation. There is no initializer to call later. For
   deployed accounts, use `GrantSessionKey.s.sol` (ERC20) or
   `GrantSessionKeyNative.s.sol` (NATIVE). Note the ERC20 script now takes a
   fourth argument, the allowed recipient. A new or broader holder grant is
   scheduled, not active. Wait `GRANT_INCREASE_DELAY`, then call
   `ActivateSessionKeyGrant.s.sol` or call
   `activatePendingSessionKeyGrant(holder)` from the owner key. Stricter or
   equal grants activate immediately. `cancelPendingSessionKeyGrant(holder)`
   cancels a pending broader grant.

Bootstrap limits for constructor keys are policy-derived. The deployment path
uses fixed allowed mode, max caps, max expiry, period, and policyVersion constants
that match the registered tenant policy digest. Do not accept constructor key
mode, caps, expiry, or policyVersion from free-form script input.

### Signature-shape changes to expect

These are ABI changes, so any off-chain caller you have outside this repo needs
the same edit:

- `registerAgent`, `updateBehaviorHash`, `revokeAgent` take an explicit
  `authSigner` before the signature. This is required, not cosmetic: an ERC-1271
  contract signature cannot be recovered from, so the claimed signer has to be
  supplied for the membership check.
- `getPolicy` returns a fourth value, `exists`, so callers can tell "never
  registered" from "registered with a zero hash".
- `getAgent` returns a struct (tuple), which is what the ABI always described.
- `setAttestor` and `setArbiter` are now proposals: the role moves only when the
  named address calls `acceptAttestor` / `acceptArbiter`.

### Signer compatibility check before you re-register

`BrainSignatureChecker.recoverEoa` is strict about `v`: it accepts 27 and 28 and
rejects everything else. The previous inline implementation normalised `v < 27`
by adding 27, which made two distinct 65-byte signatures recover the same signer.
Brain's off-chain signers use viem, which emits 27/28, so this should be a no-op.

If you have any signer outside this repo (a hardware wallet flow, a partner
integration), verify one signature against the new registry on Sepolia BEFORE
re-registering a whole tenant. A Safe can now be a tenant signer via ERC-1271,
which was impossible before.

## Session-key cap mode: pick the right one

Granting the wrong mode is the easiest way to ship an unmetered key.

Broader grants are now delayed on-chain. The contract treats these as broader:
new holders, raised `maxPerTx`, raised `maxPerPeriod`, extended `validUntil`,
earlier `validAfter`, new targets, new selectors, new ERC20 recipients, shorter
period windows, removed pinning, changed policy version, changed cap token, or
changed cap mode. Lower caps, removed allowlist entries, later `validAfter`, and
added pinning can activate immediately when every other field is equal or
stricter.

Pause, account-wide pause, revoke, and pending-grant cancel remain immediate
owner actions. `revokeSessionKey(holder)` also clears any pending broader grant
for that holder.

| Use case                | Mode     | `capAmountOffset`            | Notes                                                                                            |
| ----------------------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Native ETH transfer     | `NATIVE` | 0                            | `data` MUST be empty; selector and recipient lists MUST be empty                                 |
| USDC / ERC-20 payment   | `ERC20`  | 0                            | target MUST be the token; `allowedRecipients` is the counterparty binding; `approve` is rejected |
| `BrainEscrow.release`   | `CALL`   | **36**                       | the `amount` word of `release(bytes32,uint256)`; pin `escrowId` at `pinOffset` 4                 |
| Any other contract call | `CALL`   | offset of its uint256 amount | must be `>= 4` and word-aligned                                                                  |

A `CALL`-mode key can only target functions that carry a uint256 amount at a
declared offset. `CALL` is NOT a superset of `ERC20`: `approve`,
`increaseAllowance`, `transfer` and `transferFrom` are rejected at grant time,
because `CALL` has neither allowance accounting nor a recipient binding. Grant
token movement in `ERC20` mode.

Whether the word at `capAmountOffset` is really an amount is the GRANTOR's
responsibility. The account cannot read an ABI. A `CALL` grant therefore
carries exactly ONE selector, so the offset names one argument of one known
function rather than being shared across up to 32 selectors where it may be
`amount` in one and a timestamp in another. The remaining duty is yours: if that
argument is a DYNAMIC type (`bytes`, `bytes[]`, `string`, a dynamic array) the
word is an ABI head offset, not a value, and the key meters a constant.
`multicall(bytes[])` at offset 4 meters `32` no matter how much it moves. Grant
`CALL` keys only over static `uint256` arguments.

`CALL` meters the amount but binds nothing about WHICH object the call acts on.
Use the optional `pinOffset` / `pinValue` pair to pin one further 32-byte
argument word. **Escrow keys MUST pin `escrowId` at offset 4.** The smart
account is the arbiter of every escrow naming it, and `BrainEscrow.refund`
accepts the arbiter at any time with no deadline, so an unpinned
`[BrainEscrow] x [refund(bytes32,uint256)]` key can force-refund any other
tenant's escrow and charge it against its own cap.

Spend windows anchor to the holder's FIRST grant rather than to the unix epoch
or to the current key's `validAfter`. A per-task key whose lifetime equals one
period therefore has exactly ONE accounting window, and re-granting or
revoke-then-regranting a key does not reopen the period budget. Under the epoch
scheme a boundary almost always fell inside the lifetime, letting such a key
spend its full cumulative cap twice.

## Escrow arbiter must be the smart account

`EscrowBaseRail` routes releases through
`BrainSmartAccount.executeViaSessionKey`, so `msg.sender` at `BrainEscrow` is the
**smart account**, not the session-key EOA. The smart account must therefore be
the escrow's `payer` or its `arbiter`, or `release` reverts with
`NotAuthorized`.

The old code comment claimed the opposite ("the escrow is called directly by the
session-key EOA (the same EOA is the arbiter)"). If the current testnet escrow
was deployed with the EOA as arbiter, releases would have reverted on that
ground too, independently of the wrong selector.

## Verification after cutover

```bash
cd contracts && forge fmt --check && forge build --sizes && forge test -vvv
```

```bash
pnpm typecheck && pnpm test && pnpm lint
```

```bash
node scripts/check-contract-abi-drift.mjs
node scripts/verify-audited-build.mjs
node scripts/check-audit-status.mjs
```

Then, on the target environment:

1. `GET /health` reports the expected commit.
2. Mint a dev token and hit an authenticated route (the agent registry is on the
   MCP auth path; a wrong `MCP_AGENT_REGISTRY_ADDRESS` shows up as
   `agent_scope_hash_mismatch`).
3. Confirm gate check 5.5 accepts a known agent payee for its OWN tenant and
   rejects it for a different tenant. This is the cross-tenant fix and it is
   invisible in a single-tenant smoke test.
4. Confirm the anchor publisher writes one anchor after cutover, and that
   `latestAnchorFull` reports the new window rather than a stale one.

## Rollback

Old addresses stay live and fully functional. Rollback is reverting the env
values and restarting; no on-chain action is required. Keep the previous
addresses recorded until the new deployment has published at least one anchor
and settled at least one payment.
