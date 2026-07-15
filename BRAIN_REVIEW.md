# Brain Full Code Review

Findings accumulate here across tiers. Each tier is audit-only unless a fix is
explicitly requested. Severity scale: critical / high / medium / low / info.

---

## Tier 0: Contracts + Payment Path

Repo: braindotfi/brain-core. Branch: review/tier-0-contracts-payment.
Model: Opus 4.8. Scope: BrainEscrow, BrainSmartAccount and the other contracts;
the payment execution path from policy approval through on-chain submission;
session-key issuance, capping, and denomination; the mainnet fence for the
unaudited escrow contracts.

### Architecture note (for future sessions)

The on-chain money rail is NOT ERC-4337. BrainSmartAccount has no EntryPoint, no
UserOperation, no paymaster. The session-key holder calls
`executeViaSessionKey` directly and the account enforces scope on every call.
The Tier 0 prompt's "UserOp construction and submission" framing maps onto this
direct-call design. The off-chain path is PaymentIntent -> policy gate -> audit
-> execution, and on-chain settlement is either a direct session-key call or a
BrainEscrow lock/release.

### Checklist

- [x] BrainEscrow.sol read and analyzed
- [x] BrainSmartAccount.sol read and analyzed
- [x] BrainPolicyRegistry.sol read and analyzed
- [x] BrainAuditAnchor.sol read and analyzed
- [x] BrainMCPAgentRegistry.sol read and analyzed
- [x] BrainReputationRegistry.sol / IBrain interfaces skimmed
- [x] Deploy + GrantSessionKey Forge scripts read
- [x] Session-key issuance / capping / denomination (on-chain scripts + TS helpers)
- [x] Payment execution path: propose-only enforcement (no submit without human approval), REVIEWED, see T0-11
- [x] Mainnet fence for unaudited escrow contracts: intact and non-bypassable, CONFIRMED
- [x] Final Tier 0 verdict + propose-only invariant confirmation, see verdict below

### Fix status

- [x] T0-1 fixed: GrantSessionKey now grants ERC20-mode keys with capToken set to the allowed token.
- [x] T0-2 fixed: BrainSmartAccount rejects native-mode grants that allowlist decodable ERC20 selectors.
- [x] T0-3 fixed: TS session-key helper shapes now require explicit capToken and raw integer token-unit amounts.
- [x] T0-4 fixed: Agent behavior updates and revocations now bind per-agent nonces in their EIP-712 payloads.
- [x] T0-5 fixed: payment-key grants no longer include ERC20 approve.
- [x] T0-6 fixed: Deploy scripts now require Base Sepolia chain id before broadcasting.
- [x] T0-8 fixed: Escrow audit and bytecode gates now require the full audit path on any non-testnet chain.
- [x] T0-9 fixed: API boot now checks explicit BASE_RPC_URL eth_chainId against BRAIN_BASE_CHAIN_ID.
- [x] T0-10 fixed: x402 autonomy now requires signed on-chain permission and a policy-authored per-action cap.
- [x] T0-11 fixed: on-chain actions now have a hard recorded-human-approval floor, with a capped x402 carve-out.
- [x] T0-12 fixed: Production boot now fences attestCounterpartyAgent and sumAgentWindowSpend.
- [x] T0-13 closed: off-chain reservations are intentionally skipped for x402_settle and escrow_release.

### Mainnet fence verdict: INTACT and not bypassable via any escrow funds path

The fence for the unaudited BrainEscrow is present, fail-closed, and layered.
It is a boot-time refuse-to-boot fence (`services/api/src/composition/escrow-audit-gate.ts`,
wired at `services/api/src/main.ts:374-403` before the rail registry is built).
On Base mainnet (`chainId === 8453`) with `BRAIN_ESCROW_ADDRESS` set it requires,
fail-closed, ALL of: (1) `contracts/audit-status.json` status `approved` via the
shared canonical validator (`shared/src/audit-status.ts` evaluateApproval:
auditor, 40-hex commit, report ref, zero critical/high, build-binding hashes,
compiler, and `approved_chain_ids` including 8453) plus an operator env
attestation; and (2) on-chain `eth_getCode` bytecode byte-match (immutable-masked)
against the audited `runtime_bytecode_sha256`.

Why it cannot be dodged: `BRAIN_BASE_CHAIN_ID` (default 84532 Sepolia) drives BOTH
the gate check AND the viem chain object used to sign every tx
(`onchainExecutor.ts:47`, `8453 ? base : baseSepolia`), so it sets the EIP-155
chain id. Landing a valid mainnet tx requires 8453, which fully arms the gate;
setting 84532 to dodge it signs Sepolia txs a mainnet node rejects. Current
committed config is fail-closed: audit-status.json is `pending` (all evidence
null), `docker-compose.prod.yml` pins `BRAIN_BASE_CHAIN_ID: "84532"`, no escrow
address in prod. Anchor and policy broadcasters hardcode `baseSepolia`, so they
can never sign a valid mainnet tx. Defense in depth: `check-gate-bypass.mjs`,
`check-escrow-audit-marker.mjs`, `check-audit-status.mjs`, shadow-first escrow
rail.

#### T0-8 (MEDIUM), Escrow audit gate hardcodes 8453; "any non-testnet chain" not literally enforced

- Location: `services/api/src/composition/escrow-audit-gate.ts:34,145,221`.
- Both fences early-return for any `chainId !== 8453`, so Ethereum (1), Optimism
  (10), Arbitrum (42161), Polygon (137) are not fenced. Mitigated today because
  the executor maps every non-8453 value to the `baseSepolia` chain object, so
  such a tx is EIP-155-signed for 84532 and rejected by the real chain. This is a
  spec-vs-implementation mismatch, not a reachable funds path, but if the chain
  map were ever broadened, the gate must broaden with it. Suggested: gate on an
  explicit testnet allowlist and refuse any chain id not on it.

#### T0-9 (LOW), Fence trusts self-declared BRAIN_BASE_CHAIN_ID, never probes the RPC's real chain id

- Location: `services/api/src/composition/escrow-audit-gate.ts` (reads via
  `eth-getcode.ts`); the gate never calls `eth_chainId` on `BASE_RPC_URL`.
- Fail-closed in every direction traced today (thanks to the EIP-155 coupling), so
  informational, but the fence's correctness rests entirely on that coupling
  rather than an explicit on-chain chain-id assertion. Suggested: probe
  `eth_chainId` at boot and assert it equals `BRAIN_BASE_CHAIN_ID`.

#### T0-10 (MEDIUM), x402 USDC mainnet settlement is not covered by the escrow audit fence

- Location: `services/api/src/rails/x402Client.ts:31,34,47`.
- x402 uses the same `chainId === 8453 ? base : baseSepolia` selection and, on
  8453, `transfer`s real USDC. It does not touch BrainEscrow, so it is
  legitimately outside the escrow fence, but it IS real mainnet money movement
  gated only by the generic `rails-prod-fence`, not by any audit gate. Flagged so
  x402 is not assumed to inherit the escrow fence's protection; confirm the
  rails-prod-fence provides an equivalent human-approval + prod guard for x402.
- Group B closure: x402 settlement now has the equivalent gate-level human
  approval floor unless the matched signed policy rule sets both
  `onchain_settlement_permitted: true` and `x402_autonomous_max_amount` covering
  the action amount. Missing, malformed, wrong-currency, or over-cap data routes
  to recorded human approval before dispatch.

### Findings

#### T0-1 (HIGH), ERC-20 (USDC) session key granted in NATIVE mode: spend caps silently unenforced

- Location: `contracts/script/GrantSessionKey.s.sol:43-54` (root cause enabled by
  `contracts/src/BrainSmartAccount.sol:174-198` and `:311-330`).
- This is the repo's designated "ERC-20 variant" grant script. It allowlists the
  USDC token as the sole target and the ERC-20 selectors
  (transfer / transferFrom / approve), sets `maxPerTx: 1_000e6` and
  `maxPerPeriod: 10_000e6` (correct 6-dp USDC raw units), but sets
  `capToken: address(0)`, which is NATIVE mode.
- Why it grants: `grantSessionKey` only enforces the ERC-20-mode consistency
  checks when `capToken != 0` (`BrainSmartAccount.sol:181`). With `capToken == 0`
  those checks are skipped; the H-03 non-empty-allowlist and non-zero
  policyVersion checks all pass, so the key is stored without complaint.
- Failure scenario: at execution, `capToken == 0` means
  `capAmount = value` (`BrainSmartAccount.sol:312`). A USDC `transfer(to, amount)`
  call carries `value == 0`, so `capAmount == 0`. The per-tx check `0 > maxPerTx`
  is false and the period check adds 0, so ANY `amount` passes. The `to` argument
  is unconstrained (only the token contract is allowlisted as `target`). The
  session-key holder can move the account's ENTIRE USDC balance to any recipient,
  uncapped. The advertised 1,000 / 10,000 USDC caps, printed to the console at
  grant time and stated in the docstring, do not exist at runtime.
- This is a reintroduction of the "session-key cap denomination bug" class the
  review brief specifically flagged. BrainSmartAccount's ERC-20 mode exists
  precisely to prevent it; the script routes around it by using NATIVE mode for a
  token.
- Reachability today: the automated TS execution rail only submits ETH value
  transfers (`services/api/src/main.ts` resolveOnchainParams sends `data:"0x"`),
  so it does not itself exercise a USDC transfer. The exposure is a
  holder-signed direct call, which is exactly the script's stated purpose. If this
  script (or its pattern) is used to provision the production agent key, the agent
  ships with no effective USDC cap.
- Suggested fix (not applied): set `capToken: allowedToken` in the script (ERC-20
  mode), which flips on the grant-time constraints and meters the decoded token
  amount. Defense in depth: have `grantSessionKey` reject the known ERC-20
  selectors (transfer / approve / transferFrom) when `capToken == 0`, so a
  token-denominated cap can never be silently issued as NATIVE.

#### T0-2 (MEDIUM), grantSessionKey permits an ERC-20 token target in NATIVE mode (root cause of T0-1)

- Location: `contracts/src/BrainSmartAccount.sol:174-198`.
- In NATIVE mode (`capToken == 0`) there is no restriction preventing an ERC-20
  token contract from appearing in `allowedTargets` with a transfer selector. The
  caps then meter only `msg.value`, which is 0 for token calls, so token movement
  is un-metered. The contract is the last line of defense for the money rail and
  currently allows a mis-denominated key to exist. Fixing this at the contract
  level neutralizes T0-1 and both latent TS variants (T0-3) at once.
- Suggested fix (not applied): in `grantSessionKey`, when `capToken == 0`, reject
  any allowlisted selector in the decodable ERC-20 set, forcing token caps to use
  ERC-20 mode.

#### T0-3 (LOW), Two latent TS session-key helpers repeat the NATIVE-mode / decimals mistake

- `services/execution/src/rails/session-keys.ts:16-64`
  (`derivePerTaskSessionKey` / `PerTaskSessionKeyParams`): the params type has no
  `capToken` field at all and documents amounts as "wei", and `allowedSelectors`
  defaults to `[]`. If ever wired to build a real ERC-20 grant, it would encode
  `capToken = 0` (NATIVE, silently uncapped for token transfers) and would revert
  at grant with `SelectorsRequired` if selectors stayed empty. Latent: only
  re-exported and used in its own test; nothing encodes it into `grantSessionKey`
  calldata today.
- `services/execution/src/open-ecosystem/spend-permission.ts:122-136`
  (`toSessionKeyShape`): maps a decimal-dollar allowance string (e.g. "10.00")
  directly to `maxPerPeriod` and omits `capToken`. On-chain caps expect raw
  integer token units, not a decimal dollar string. Docstring marks it
  "illustrative / for parity assertions," so not on the grant path today, but a
  decimals + mode landmine if promoted.
- Suggested fix (not applied): give both helpers an explicit `capToken` and
  raw-unit amounts, or delete/annotate them so they cannot be mistaken for grant
  builders.

#### T0-4 (MEDIUM), BrainMCPAgentRegistry.updateBehaviorHash has no replay protection

- Location: `contracts/src/BrainMCPAgentRegistry.sol:161-178`.
- The EIP-712 digest for `updateBehaviorHash` binds only
  (agentId, tenantId, behaviorHash): no nonce, no deadline, no monotonic
  version. `setTenantSigner` in the same contract DOES use `signerNonce`, so the
  omission reads as an oversight. All on-chain calldata is public, so any
  previously-submitted `updateBehaviorHash` signature can be replayed by anyone,
  indefinitely, as long as the original signer remains an authorized tenant signer
  and the agent is not revoked.
- Failure scenario: a tenant runs an agent with behaviorHash H1 (a model/prompt
  config later found unsafe), then promotes to H2. The gate (check 1.5) now
  only authorizes H2. An attacker replays the public H1 signature, forcing the
  registered behaviorHash back to H1, re-authorizing the deprecated/unsafe
  behavior on-chain and desynchronizing the attestation from tenant intent. The
  behaviorHash registry is a safety control; this is a safety-control integrity
  break.
- Mitigation that exists: if the tenant rotates the signer set after each update,
  the old signer is no longer authorized and replay reverts, but nothing in the
  contract requires that, and it is not the expected operational model.
- Suggested fix (not applied): add a per-(tenant or agent) nonce to the
  behavior-update (and, for consistency, revoke) typehash, matching the
  `signerNonce` pattern already in the contract.

#### T0-5 (LOW), ERC-20 `approve` allowances survive session-key revocation / pause

- Location: `contracts/src/BrainSmartAccount.sol:205-251` (revoke/pause) vs the
  ERC-20 allowlist including `approve` (`GrantSessionKey.s.sol:41`,
  `BrainSmartAccount.sol:190`).
- `approve` is an allowed selector for the agent key. `revokeSessionKey`,
  `pauseSessionKey`, and `pauseAll` stop future `executeViaSessionKey` calls but
  do NOT claw back ERC-20 allowances already granted via `approve`. A compromised
  or malicious holder can `approve` a colluding spender for up to `maxPerTx`
  within caps; that allowance persists after the owner revokes the key, and the
  spender drains it out-of-band via the token's own `transferFrom` (which the
  account never sees). Bounded per-tx by the cap, but the revocation guarantee is
  weaker than it appears.
- Suggested fix (not applied): consider excluding `approve` from the agent
  payment key's selector allowlist (a payment key arguably only needs
  `transfer`), or document that revocation does not revoke outstanding
  allowances and require the owner to zero them on incident response.
- Group B closure: the payment-key grant script now issues only ERC20
  `transfer` and `transferFrom`. `approve` remains supported by
  BrainSmartAccount for non-payment keys, and revocation still cannot claw back
  any pre-existing token allowance.

#### T0-6 (LOW), Deploy scripts have no on-chain chain-id fence

- Location: `contracts/script/DeployEscrow.s.sol:22-33` (and peers).
- The "UNAUDITED / testnet only" status is enforced procedurally (docstring says
  to pass `--rpc-url base_sepolia`), not by code. Nothing in the deploy script
  reverts on a mainnet chain id, so an operator error (`--rpc-url <mainnet>`)
  would deploy the unaudited escrow to mainnet. The load-bearing fence is the
  off-chain runtime gate, but a `require(block.chainid == <testnet>)` in the
  deploy script would be cheap defense in depth.

#### T0-7 (INFO), Minor contract hardening observations

- `BrainSmartAccount.grantSessionKey` does not validate `validAfter < validUntil`;
  a key with `validAfter >= validUntil` is permanently inactive (footgun, not a
  vuln). `contracts/src/BrainSmartAccount.sol:174`.
- `executeViaSessionKey` does not re-verify `policyVersion` against
  `policyRegistry` on-chain (documented gas tradeoff); the on-chain policyVersion
  is therefore an advisory event tag, not an enforced binding.
  `contracts/src/BrainSmartAccount.sol:343-349`.
- `BrainAuditAnchor.anchor` has no period monotonicity check, so a trusted
  publisher could overwrite `latestByTenant` with an older-period root; fields are
  advisory and the publisher is a 2-of-3 multisig, so low impact.
  `contracts/src/BrainAuditAnchor.sol:72-91`.
- A revoked `agentId` in BrainMCPAgentRegistry is burned forever (re-registration
  reverts `AgentAlreadyRegistered`), an availability quirk, not a security hole.
  `contracts/src/BrainMCPAgentRegistry.sol:136`.

#### T0-11 (HIGH), Propose-only is policy-conditional: no hard code gate forces human approval for on-chain actions

- Location: `shared/src/gate/gate.ts:855` (check 11 only runs for outcome
  `confirm`); `services/execution/src/payment-intents/PaymentIntentService.ts:415-420`
  (`allow` -> `approved` with no signature); `:937-949` (`execute` requires only
  `status === "approved"`).
- Submission path map (the single choke point is the pre-execution gate):
  `create()` evaluates policy and sets status directly from the outcome: `reject`
  -> rejected, `confirm` -> pending_approval, `allow` -> approved with zero
  approval signatures. `execute()` requires `status === "approved"`, runs
  `runPreExecutionGate`, then atomically transitions `approved -> dispatching` and
  `outbox.enqueue`. The outbox worker (`outbox/worker.ts:176`) is the ONLY on-chain
  submission site: it calls `rail.dispatch()` -> onchain-base
  (`executeViaSessionKey`), x402-base (USDC transfer), or escrow-base
  (`BrainEscrow.release`). Execution is always agent-driven: gate check 1
  (`gate.ts:419`) requires `principal.type === "agent"`.
- The invariant break: approval signatures are verified by gate check 11 ONLY when
  the policy outcome is `confirm`. When policy returns `allow`, the intent reaches
  `rail.dispatch()` and a real on-chain tx with NO recorded human approval. There
  is no defense-in-depth check of the form "on-chain action_type (onchain_transfer
  / x402_settle / escrow_release) requires a recorded approval regardless of policy
  outcome." The "propose-only / no on-chain tx without prior human approval"
  invariant is therefore NOT enforced by code, it rests entirely on each tenant's
  policy returning `confirm` for on-chain actions.
- Failure/exploit scenario: an over-broad or misconfigured tenant `allow` rule for
  `onchain_transfer`/`escrow_release`, or one whose matched evidence/amount is
  steered by a prompt-injected document under an `allow` threshold, lets a
  compromised or buggy agent submit an on-chain transaction autonomously. Nothing
  restricts autonomous `allow` execution to micropayments or to a value cap.
- DESIGN-INTENT QUESTION for Damon: this may be intended (a human-authored,
  EIP-712-signed, on-chain-registered policy returning `allow` IS the codified
  human authorization, and autonomous execution is the point of x402
  micropayments). If so, the finding narrows to: (a) the marketing/architecture
  "propose-only, no tx without human approval" language overstates what the code
  guarantees, and (b) there is no hard floor forcing per-action approval for
  higher-risk on-chain types. If the literal invariant is required, this is a
  code-enforcement gap. Recommend a hard gate: on-chain action types require a
  recorded approval signature independent of outcome, or an explicit
  policy-authored, value-capped allowlist for autonomous on-chain execution.
- COMPOUNDING with T0-1/T0-13: for `onchain_transfer`/`x402_settle`/`escrow_release`
  the off-chain balance/reservation ceiling is skipped (T0-13), so the on-chain
  session-key cap is the sole spend ceiling, and T0-1 shows that cap can be
  silently zero (NATIVE-mode miscap). An `allow`-outcome on-chain transfer executed
  by a miscapped NATIVE-mode key would have NO effective ceiling at any layer.
- Group B closure: gate check 11 now enforces a hard human-approval floor for
  `onchain_transfer` and `escrow_release` regardless of policy outcome. For
  `x402_settle`, approval-free execution is allowed only when the signed policy
  rule explicitly permits on-chain settlement and carries an
  `x402_autonomous_max_amount` cap that covers the amount. `create()` mirrors the
  same decision so approval-required on-chain `allow` intents enter
  `pending_approval` instead of sitting in `approved` but blocked at execute time.

#### T0-12 (MEDIUM), Dormant-safety-loader containment for gate checks 5.5 and 8.5 is lint-only, not a boot fence

- Location: `shared/src/gate/gate.ts` (checks degrade to `not_applicable`/pass when
  their loader is absent: 1.5, 5.5, 6.6, 6.7, 8, 8.5, 9.5, 11.5); production fences
  `services/api/src/main.ts:821` (`assertMoneyPathLoadersWiredInProduction`) and
  the `check-payment-intent-loaders.mjs` source-grep lint.
- This is the "dormant safety loader" class from the brief. Currently NOT
  exploitable: both `PaymentIntentService` construction sites (`main.ts:830`,
  `:1623`) thread all loaders, and the boot fence covers checks 8, 9.5, 11.5,
  obligation-confidence, and 6.7. The gap: `attestCounterpartyAgent` (check 5.5,
  M2M agent-payee attestation) and `sumAgentWindowSpend` (check 8.5, micropayment
  window cap) are guarded ONLY by the source-grep lint, not by a runtime boot
  fence. A refactor that keeps the identifier but passes `undefined`, or a new PI
  construction site outside `services/`, would silently disable those two checks
  without CrashLooping. Mitigating: `makeAttestCounterpartyAgent`
  (`services/policy/src/agent-attestation.ts:74`) fails closed (absent/erroring
  registry -> `attested:false` -> reject).
- Suggested fix (not applied): add checks 5.5 and 8.5 to
  `assertMoneyPathLoadersWiredInProduction` so their absence is a boot fence, not a
  lint that a refactor can slip past.

#### T0-13 (LOW), x402_settle and escrow_release skip the off-chain balance/reservation gate (confirm intent)

- Location: `services/execution/src/payment-intents/PaymentIntentService.ts:76`
  (`requiresExecutionReservation()` returns false for `x402_settle` /
  `escrow_release`); `shared/src/gate/gate.ts:737` (check 8 `not_applicable` for
  both).
- These two on-chain paths have no off-chain balance ceiling; enforcement relies
  entirely on on-chain caps (session-key `maxPerTx`/`maxPerPeriod`, escrow
  `remaining` in check 6.6) plus the optional window cap 8.5 (active only if policy
  sets `micropayment_window_cap`). Intended per the comments, but confirm the
  on-chain caps are the deliberate sole ceiling, and note the T0-1 compounding
  above, since a NATIVE-mode miscap removes that sole ceiling.
- Group B closure: this is confirmed as intentional. `x402_settle` and
  `escrow_release` rely on on-chain caps as the spend ceiling and intentionally
  skip the off-chain reservation gate. The B1 hard human-approval floor now sits
  above those caps.

### Confirmed-correct invariants (audit questions answered)

- Ordering, audit-before-execution: audit-before is emitted inside the gate
  (`gate.ts:911`) before the atomic `approved -> dispatching` + `outbox.enqueue`;
  audit-after is emitted by the worker after `rail.dispatch()` (`worker.ts:220`).
  The outbox row carries `audit_before_id` and the worker refuses to dispatch
  without it (`worker.ts:162`). `PaymentIntentService.ts:1200` refuses `executed`
  when `policy_decision_id` is null.
- Ordering, signature before unlock: `approvals.sign()`
  (`PaymentIntentService.ts:567`) runs before the status transition that unlocks
  execution (`:620`/`:579`), and only after `authorizeApproval` passes.
- No policy-bypass-via-omitted-tenant bug found: all gate loaders scope via
  `withTenantScope(pool, ctx.tenantId, ...)` (`services/api/src/gate-loaders/index.ts`);
  the gate always passes `input.ctx.tenantId` and loaders re-scope by it. No call
  site omits or defaults the tenant.
- Single choke point enforced: `rail.dispatch()` exists only in `outbox/worker.ts`
  and the `executed` transition only in `PaymentIntentService.ts`, enforced at CI
  by `scripts/check-gate-bypass.mjs` and backed at runtime by the `audit_before_id`
  and `policy_decision_id` refusals above.
- Other guards confirmed wired: `BRAIN_DEMO_MODE` refused in production
  (`main.ts:445`), stub rails fail closed in production (`rails/stubs.ts:24`),
  `assertAtLeastOneLiveRailInProduction` (`main.ts:925`), `AgentService` handles
  only non-financial proposals (all money movement routes through
  `PaymentIntentService`).

### Tier 0 verdict

The contracts are carefully written and the off-chain execution path has a genuine
single choke point with correct audit-before-execute and signature-before-unlock
ordering, a fail-closed and non-bypassable unaudited-escrow mainnet fence, and no
tenant-omission bug. Two items are the headline risks and both are the exact past
bug classes the brief named:

1. T0-1 (HIGH): the shipped ERC-20 session-key grant script silently produces an
   uncapped USDC key (cap-denomination class). Contract-level root cause T0-2.
2. T0-11 (HIGH) is closed by Group B: on-chain `allow` outcomes now require a
   recorded human approval before dispatch, except for policy-authored,
   value-capped x402 autonomy.

T0-4 (behaviorHash replay), T0-10 (x402 outside the escrow fence), T0-12
(lint-only loader containment for 5.5/8.5), and T0-8 (gate hardcodes 8453) were
the medium tier and are now closed by the remediation branches. The propose-only
invariant now has code-level enforcement for on-chain money movement: policy
`allow` no longer auto-dispatches `onchain_transfer` or `escrow_release`, and x402
autonomy requires explicit signed policy permission plus a per-action cap. Overall
Tier 0 readiness is materially improved, with the remaining production launch
gates moving to external audit, bytecode verification, and exercised deployment
evidence rather than unresolved Tier 0 contract-path findings.

### Positives worth recording

- BrainEscrow: correct checks-effects-interactions in release/refund, a
  reentrancy latch, a fee-on-transfer balance-delta guard on lock, SafeERC20-style
  transfer wrappers, and settled ids that can never be reused.
- BrainSmartAccount: per-holder replay nonce, per-holder reentrancy guard,
  two-step ownership, per-holder and account-wide kill switches, and grant-time
  ERC-20-mode consistency checks (which T0-1/T0-2 route around only in NATIVE
  mode).
- BrainPolicyRegistry and BrainMCPAgentRegistry: EIP-712 with a low-s malleability
  guard, write-once policy versions with strict monotonicity, signer-count
  bootstrap that avoids permanent lockout, and (for policy) a replay nonce on
  signer changes.
- BrainAuditAnchor: two-step publisher rotation, idempotent (tenant, root)
  publication, and domain-separated Merkle inclusion (0x00 leaf / 0x01 internal)
  that resists second-preimage.

---

## Tier 1: Policy + Gating

Repo: braindotfi/brain-core. Branch: review/tier-1-policy-gating.
Model: Opus 4.8. Scope: pre-execution policy gate, propose-only enforcement,
audit-anchor sweep, trust state machine, RLS posture, and DB role separation.

### Fix status

- [x] T1-20 fixed: anchor orphan recovery now uses the audit-verifier BYPASSRLS
      pool, not the request pool, so the cross-tenant orphan scan cannot false-clean
      under FORCE RLS.
- [x] T1-21 fixed: anchor reconciler and audit consistency workers now emit
      cycle-failure counters and last-success heartbeat gauges.
- [x] T1-22 fixed: `/internal/audit/health` escalates stale verifier evidence
      instead of reporting `safe` forever after one old clean pass.
- [x] T1-4 fixed: `/v1/agents/{id}/halt` quarantines first, then pauses approved
      intents in one tenant transaction; the execution outbox worker rechecks creator
      agent state before rail dispatch and parks blocked rows in `reconciling`.
- [x] T1-14 fixed: on-chain gate context now fails closed from
      `action_type`; `x402_settle` requires settlement context and
      `escrow_release` requires escrow context.
- [x] T1-15 fixed: policy outcome check now whitelists canonical `allow` and
      `confirm` outcomes and rejects anything else.
- [x] T1-16 fixed: the production loader fence now requires
      `resolveTenantFlags` so behavior-hash pinning cannot be silently
      disabled.
- [x] T1-17 fixed: boot now asserts a live `escrow_base` rail has
      `resolveEscrowState` wired.
- [x] T1-18 fixed: gate metric emission is exception-guarded and cannot change
      a gate decision.
- [x] T1-7 fixed: the gate-bypass guard now scans API rail signing sinks and
      rail-client imports.
- [x] T1-9 fixed: `brain_privileged` is no longer in the blanket table DML
      grant, has an explicit seed and verifier footprint, and cannot INSERT
      into `audit_events`.
- [x] T1-10 fixed: tenant deletion keeps the BYPASSRLS erasure role, but every
      DELETE is built through a checked tenant-predicate helper and
      predicate-less DELETE is rejected by test.
- [x] T1-11 fixed: unused DELETE grants are removed from the raw worker and
      ledger projector. The canonical projector keeps only the verified
      `canonical_journal_line` DELETE needed for journal-line replacement.
- [x] T1-23 fixed: API-owned tenant tables now have an app migration that
      applies FORCE ROW LEVEL SECURITY.
- [x] T1-5 fixed: `/v1/agents/{id}/restore` CAS-restores only
      `quarantined -> active`; non-quarantined states fail closed.
- [x] T1-6/T1-8/T1-13 fixed: API-key revoke uses the agent state machine,
      HTTP propose routes pin agent-token attribution to the authenticated
      agent principal while leaving human sessions non-agent-attributed, and
      the dead actions `tenantId` body field is removed.
- [x] Group B fixed: fiat rails now have a default-on human approval floor,
      production confidence-floor activation lint is wired with a reject-mode
      flag, and the H-09 contribution intake surface is renamed to
      contribution hold.

### Tier 1 verdict update

The mergeable core HIGH defects from the Tier 1 review are fixed. Audit sweep
observability no longer fails silently, and halted agents can no longer dispatch
already-queued outbox rows after the worker observes quarantine. P3 fail-closed
hardening, P5 route hygiene, P4 DB least-privilege items, the API FORCE RLS gap,
the outbox guard boot fence, and the operator restore route are fixed. Group B
is also fixed: fiat rails now match the x402 signed-cap autonomy model where
applicable, production confidence-floor lint is wired at activation, and the
old H-09 contribution intake wording has been replaced by contribution hold.

---

## Tier 2: Workflows + Platform

Repos: braindotfi/brain-core (workflow logic) and braindotfi/BrainMVB (platform
UI, reviewed at /Users/damon/BrainMVB). Branch: review/tier-2-workflows-platform.
Scope: the four public workflows (Invoice = vendor_risk + payment + fraud_anomaly;
Collections; Cash = treasury + cash_forecast; Close = reconciliation); the five
MVP ingestion connectors (Plaid, Stripe, Merge/accounting, Finch/payroll,
document/email); and BrainMVB and its calls into brain-core. Two hard invariants:
core leads and client follows (BrainMVB never assumes an endpoint brain-core does
not expose), and manually entered bank details are never persisted. Audit only.

### Checklist

- [x] Invoice Agent (vendor_risk + payment + fraud_anomaly): T2-13..T2-19; propose-only holds
- [x] Collections Agent: scaffolding, not implemented (T2-7, T2-8, T2-9)
- [x] Cash Agent (treasury + cash_forecast): scaffolding + money-handling bugs (T2-7, T2-10, T2-11)
- [x] Close Agent (reconciliation): double-pay gap T2-1; corroboration T2-2; matching T2-3..T2-6
- [x] Five connectors: T2-20 silent drop (HIGH), T2-21..T2-25 validation/dedup/watermark
- [x] Invariant: manual bank details never persisted: HOLDS (one sign-off flag T2-26)
- [x] Invariant: core leads / client follows: HOLDS (every endpoint exists)
- [x] BrainMVB: auth/tenant sound except T2-27 (unauth integration routes); T2-28..T2-31
- [x] Final Tier 2 verdict (below)

### Findings

_Review in progress. Invoice Agent, connectors, and BrainMVB findings still landing._

#### Close Agent (reconciliation)

#### T2-1 (HIGH), Reconciliation-linked duplicate obligations can both be paid (double-pay gap)
- Location: `services/ledger/src/reconciliation/obligation-duplicate.ts:43-103` (links
  duplicates) vs `services/policy/src/duplicate-detector.ts:25-148` (gate check 11.5)
  and `services/execution/src/payment-intents/PaymentIntentService.ts:390` (create).
- The obligation-duplicate matcher is the only mechanism that recognizes two
  obligation rows as the same real-world bill, persisting a `obligation_duplicate`
  `matched` row. But VERIFIED: nothing in the policy or execution path references
  `ledger_reconciliation_matches` (grep of services/policy/src + services/execution/src
  returns zero). The duplicate gate's five rules key off `invoice_id`, `obligation_id`,
  or `destination_counterparty_id` equality. Two obligations for the same bill have
  the same amount+currency, so the only rule that could catch a cross-source pair is
  rule 3 (counterparty_id + amount), which fails when the two obligations reference
  DIFFERENT counterparty rows (the exact cross-source case the matcher exists for).
- Failure scenario: a document-extracted invoice creates obligation A (counterparty
  row "Acme (Plaid)") and the accounting sync creates obligation B for the same bill
  (counterparty row "Acme (QBO)"). Reconciliation links A and B. A payment intent
  against A and a separate one against B both reach `executed`. Real double payment.
- Amplified by T2-4 (the counterparty matcher that would merge those rows is dead).
- Suggested fix (not applied): add a duplicate-gate/detector rule that resolves the
  obligation through the reconciliation match graph and rejects if any linked
  observation already has an executed payment intent or `status='paid'`.

#### T2-2 (MEDIUM-HIGH), Corroboration lift has no status filter: an already-paid obligation raises a low-trust obligation's confidence
- Location: `services/ledger/src/reconciliation/obligation-duplicate.ts:132-177`
  (`loadIndependentObservations`); VERIFIED the query filters the right-side
  candidate only by `provenance IN ('extracted','human_confirmed')`, currency,
  direction, and due-date window, with NO `status` filter.
- So an obligation already `status='paid'` can corroborate a still-open low-trust
  obligation, and `applyCorroborationLift` (`persist.ts:135-164`) raises the open
  obligation's confidence toward 0.9. Because `resolveEffectiveConfidence`
  (`PaymentIntentService.ts:333-356`) caps intent confidence at the obligation's, and
  the VM checks `agent.confidence.gte` against it, this can flip a document-extracted
  obligation from needs-approval to autonomous-eligible for a bill already shown as
  settled. (Impact bounded on the hard-floored rails, but real for fiat carve-out
  eligibility.) Fix: add `AND status NOT IN ('paid','cancelled')` to the right-side
  query.

#### T2-3 (MEDIUM), Obligation-duplicate score ignores identity, over-matching recurring bills
- Location: `obligation-duplicate.ts:57-60` (score = amountScore*0.65 + dateScore*0.35).
- No invoice-number/description signal. Two distinct same-vendor same-amount
  obligations within the 7-day window (subscriptions, rent, biweekly invoices) score
  >= 0.8 and auto-link, feeding the T2-2 corroboration path with a false positive.

#### T2-4 (MEDIUM), Counterparty fuzzy-match is effectively dead code
- Location: `services/ledger/src/reconciliation/counterparty-duplicate.ts:141-169`
  requires an EXACT `normalized_name` match to become a candidate, and `normalizeName`
  (`services/ledger/src/service/writes.ts:580-587`) does not strip legal suffixes. So
  the probabilistic name-match branch (`counterparty-duplicate.ts:57-65`) can never
  fire in production: "Acme ... Inc" (Plaid) vs "Acme ... LLC" (QBO) never become
  candidates, never link, and the obligation-duplicate matcher (which relies on a
  prior counterparty link) never fires for that vendor. The code's own comment
  acknowledges the fuzzy path is deferred. This amplifies T2-1.

#### T2-5 / T2-6 (LOW), Matching hygiene
- `scoring.ts:47` substring tier (`na.includes(nb)`) can false-positive on short
  normalized names (word-boundary fix advised once T2-4 is addressed). The eight
  non-duplicate matchers (`invoice_payment`, `transaction_receipt`, etc.) auto-commit
  the single best candidate with no ambiguous/runner-up tier
  (`persist.ts:173`), so a wrong pick marks a transaction reconciled and can mask the
  real unmatched item.

_Close Agent positive: the reconciliation agent is propose-only (returns
`agentProposal`, never a payment_intent channel; ReconciliationService touches no
execution/outbox API). Its only money-path leverage is the confidence field, which
T2-1/T2-2 show is consumed downstream without adequate safeguards._

#### Collections Agent and Cash Agent (treasury + cash_forecast)

#### T2-7 (HIGH, production-readiness), Collections and Cash agents are scaffolding, not implementations
- Location: `services/internal-agents/src/collections/handler.ts:13-15`,
  `cash_forecast/handler.ts:18-31`, `treasury/handler.ts:37`; generic fallback
  `handler.ts:68-78`; declared-but-unpopulated contract `payloads.ts:53-61,169-179`.
- There is no dunning/prioritization algorithm in Collections and no forecast/sweep
  math in Cash. Every action resolves to the generic `agentProposal()` that forwards
  only invoice_id/counterparty_id/evidence_refs. The richer per-agent payload
  contracts (days_overdue, amount_due, available_cash, projected_inflows, net
  position, confidence band) are declared "required" but never populated and
  `validateAgentPayload` has no callers. No cross-tenant scanner emits the trigger
  events (`invoice.overdue`, `cash.balance_high`, etc.). These workflows are wired but
  not implemented. Consistent with the known doc-ingestion deploy gap. This is a
  readiness finding: the four public workflows cannot be presented as shipped.

#### T2-8 (MEDIUM), Dunning message variables are never populated
- Location: `collections/policy.template.json` (`collections_payment_reminder`
  allowed_variables) vs the payload from `handler.ts:68-78`.
- `amount_due`, `days_overdue`, `due_date`, `counterparty_name` are never set, so a
  drafted reminder renders with blank/undefined fields. The agent's own stated
  deliverable (the dunning message) is broken by construction. (Non-financial rail.)

#### T2-9 (MEDIUM), Fail-open under Ledger degradation
- Location: `services/api/src/agents/evidence-providers.ts:183-254` (best-effort
  `try/catch` -> empty evidence), `services/agent-router/src/worker.ts:76-171` (never
  checks `bundle.critical_missing` before proposing), unconditional `execute:"auto"`
  policy rule.
- A Ledger read failure silently yields an empty evidence bundle and the proposal
  proceeds to auto-approval anyway, rather than failing closed. Quality/correctness
  issue (these agents are non-financial); the pattern is the concern.

#### T2-10 (LOW-MEDIUM), Treasury silently coerces a non-string amount/currency
- Location: `treasury/handler.ts:29-32`, `readString` at `handler.ts:63-65`.
- `readString(c.amount, "0")` returns the fallback for any non-string (e.g. a JSON
  number), so a numeric `amount` becomes `"0"` and `currency` defaults to `"USD"`.
  CORRECTION to the sub-agent's claim: this does NOT produce a silent auto-approved
  zero-value transfer, because `PaymentIntentService.create` rejects `amount === "0"`
  (fail-closed) and `propose_transfer` hardcodes `action_type: "onchain_transfer"`
  which is always hard-floored (T0-11). So the real defect is a robustness bug: a
  legitimate numeric amount is silently dropped and the transfer spuriously rejected
  (or mis-denominated to USD) instead of coerced. Fix: validate/coerce the type and
  fail loudly on a malformed amount.

#### T2-11 (MEDIUM), Treasury omits confidence on the intent (defaults to 1.0)
- Location: `treasury/handler.ts:24-35` never sets `confidence`;
  `IPaymentIntentService` defaults an omitted confidence to 1.0.
- A sweep/transfer built from weak evidence still asserts full confidence, defeating
  an `agent.confidence.gte` gate. This is the confidence-floor-bypass pattern the
  Tier 1 notes flag. Bounded for treasury today because it hardcodes onchain_transfer
  (hard-floored), but dangerous if the pattern is copied to a fiat rail. Fix:
  `confidence: input.evidence.evidence_score`.

#### T2-12 (LOW-MEDIUM), execution_mode / minimum_confidence computed but not enforced
- Location: `services/agent-router/src/router.ts:128-136` computes `execution_mode`
  (including a `notify_only` downgrade below `minimum_confidence`) but
  `worker.ts:76-171` never reads `decision.execution_mode` before proposing. So the
  per-agent minimum_confidence thresholds are audited but not gating the proposal
  path.

_Collections/Cash positive: propose-only holds. `propose_transfer` is reachable only
via an explicit `requested_action` (never event-triggered per
`treasury/definition.ts:28-34` + `action-resolver.ts:94-121`), and all three agents
call `IPaymentIntentService.create`, never `.execute`._

#### Invoice Agent (vendor_risk + payment + fraud_anomaly)

Cross-cutting theme: the "H-16 agent-output gating primitives" (agent.confidence.gte,
agent.evidence_score.gte, agent.risk_level.lte) that are supposed to gate agent
behavior are LARGELY UNENFORCED across the agent workflows, via three compounding
defects (T2-13, T2-14, T2-15). The Tier 0/1 hard approval floors still stand between
any proposal and money movement, so these are efficacy/defense-in-depth failures, not
a direct autonomous-payment hole. Propose-only is structurally sound for all three
modules (vendor_risk/fraud_anomaly only emit `channel:"agent"`; payment only
`.create`, never `.execute`).

#### T2-13 (HIGH), Event-driven propose path hardcodes requiredEvidence: [], so evidence completeness always reports full
- Location: `services/agent-router/src/worker.ts:125` (`requiredEvidence: []`);
  `scoreEvidence` at `services/internal-agents/src/evidence.ts:118-127` returns
  `completeness:1, evidence_score:1, critical_missing:false` for an empty list.
- VERIFIED. The event-triggered path (the real trigger path for
  `vendor.bank_details_changed`, `payment.destination_changed`,
  `duplicate_charge.detected`, `transaction.unusual`) gathers evidence with an empty
  required list, so the bundle reports complete even when zero required evidence kinds
  were gathered. The synchronous path (`agent-run-service.ts:211`) correctly passes
  `definition.required_evidence`. Fix: pass the selected agent's `required_evidence` at
  `worker.ts:125`.

#### T2-14 (HIGH), Agent-output gating primitives silently no-op for the non-financial agent channel
- Location: `services/policy/src/service.ts:65-73` (`evaluateLegacy` Action build).
- VERIFIED the Action carries only kind/counterparty_id/amount/agent_role/timestamp;
  it never reads confidence, evidence_score, risk_level, or agent_id from the
  proposal, though the DSL defines `agent.confidence.gte` / `agent.evidence_score.gte`
  / `agent.risk_level.lte` for exactly this (`dsl.ts:63-67`). Since vendor_risk and
  fraud_anomaly (both risk_level high) only ever produce `channel:"agent"` proposals,
  `evaluateLegacy` is their sole policy path, so a tenant CANNOT gate these high-risk
  agents on confidence/evidence/risk. Fix: thread those fields into the Action (which
  also requires the handlers to populate them, T2-18).

#### T2-15 (HIGH), Payment agent omits confidence: defaults to 1.0 on the fiat rail
- Location: `services/internal-agents/src/payment/handler.ts:27-35` (builds
  `ach_outbound`/`onchain_transfer` with no `confidence`); default 1.0 per
  `IPaymentIntentService`; `resolveEffectiveConfidence` only caps when `obligation_id`
  is set (the handler sets `invoice_id`, not `obligation_id`).
- A payment proposal built from thin evidence asserts confidence 1.0, defeating the
  agent's own `minimum_confidence: 0.85` and any tenant `agent.confidence.gte` floor.
  Same pattern as T2-11 (treasury) but on `ach_outbound` (a fiat rail eligible for the
  autonomous cap carve-out), so more consequential. Fix:
  `confidence: input.evidence.evidence_score`.

#### T2-16 (HIGH), vendor_risk flags on evidence KIND presence, not risk content
- Location: `services/internal-agents/src/vendor_risk/handler.ts:18`
  (`hasRiskEvidence = items.some(i => i.kind === "counterparty_history")`).
- VERIFIED. The escalation reads only whether a `counterparty_history` item is present,
  never its content/severity. Since that kind is required for full evidence, the
  best-evidenced proposals trip `block_payment` whether the history is clean or flagged,
  while a vendor with NO history (the unknown, arguably riskier case) never escalates.
  There is no risk-scoring file under `vendor_risk/`. The module cannot actually
  distinguish a risky vendor from a clean one. (Non-financial, so an efficacy defect,
  not a money hole.)

#### T2-17 (MEDIUM), payment.destination_changed can never escalate to block_payment
- Location: `vendor_risk/definition.ts:22` (maps to `require_approval`) +
  `vendor_risk/handler.ts:20-23` (escalates only when action is
  `flag_vendor_risk`/`block_payment`).
- The classic BEC/bank-swap fraud trigger is permanently capped at "needs a human to
  approve" and can never be hard-blocked by any amount of risk evidence, contradicting
  the handler's own docstring. Impact bounded because require_approval still forces a
  human, so it is not unsafe, just less protective than intended. Fix: include
  `require_approval` in the escalation set or add a destination-change block branch.

#### T2-18 (MEDIUM), fraud_anomaly computes nothing; contract fields are dead
- Location: `fraud_anomaly/handler.ts:14-16` (generic `agentProposal` fallback);
  `AGENT_PAYLOAD_REQUIRED_FIELDS.fraud_anomaly` (`payloads.ts:150-156`) requires
  anomaly_type/anomaly_score/transaction_id/recommended_action, none populated;
  `validateAgentPayload` (`payloads.ts:169-179`) has no production callers.
- fraud_anomaly repackages context into a generic flag with no anomaly type or score
  for a reviewer; detection is entirely delegated to whatever external system emits the
  trigger event. Same scaffolding gap as T2-7 (vendor_risk output has the same
  contract mismatch). Fix: wire `validateAgentPayload` into the propose path (fail
  closed on malformed payload) and populate the declared fields.

#### T2-19 (MEDIUM), Payment handler: empty-id FK crash and silent wrong-currency default
- Location: `payment/handler.ts:29-32`, `readString` at `handler.ts:63-65`.
- Missing/`non-string` account/counterparty ids default to `""` and only fail at the
  DB FK constraint (an unhandled job error with no `payment_intent.created` audit),
  rather than a clean typed reject. And a non-string `currency` silently defaults to
  `"USD"` (a numeric amount is caught by create's `!== "0"` check, but a numeric
  currency is NOT caught anywhere), so a wrong-currency intent can be created. Fix:
  validate required context fields and coerce/reject types in the handler.

_Also observed (Invoice): the router's `execution_mode` is computed but not enforced
for the agent channel (same defect as T2-12), and `execute_payment` is a misleading
action name (payment only ever calls `.create`, never `.execute`) (LOW)._

#### Ingestion connectors (Plaid, Stripe, Merge, Finch, document/email)

Two write paths exist: Plaid/Stripe/Finch write the Ledger directly via the legacy
normalize worker; Merge and document obligations flow through the canonical projector
(retry + quarantine + metrics). The asymmetry is the root of the worst finding.

#### T2-20 (HIGH), Legacy normalize worker never retries a failed row: partial-batch writes and permanent silent data loss
- Location: `services/ledger/src/workers/normalizeWorker.ts:81-92` (poll) and `:110-114`
  (`recordNormalizationResult` called unconditionally with the error).
- VERIFIED. The poll excludes any `raw_parsed` row that has ANY `normalization_log`
  row, and a FAILED normalize writes a log row (with error set), so a failed row is
  never re-polled. `normalizeFromRaw` writes each item in its own transaction with no
  enclosing batch transaction, so a mid-batch exception (e.g. a malformed Stripe
  amount, an undefined Plaid field) commits items 1..k, aborts, logs the row failed,
  and items k+1..n are dropped forever. No metric, no quarantine, no replay (contrast
  the canonical worker's `error IS NULL OR quarantined` + bounded retries + metric +
  `replayQuarantined()`). Real financial transactions/obligations from Plaid, Stripe,
  and Finch can be silently and permanently lost while the tenant's balances look
  clean. Fix: mirror the canonical worker (retry/quarantine/metric) and make each
  extractor loop catch-and-skip per malformed item.

#### T2-21 (MEDIUM-HIGH), Plaid extractor has no runtime payload validation
- Location: `services/ledger/src/extractors/plaid.ts:89-90` (bare `as` casts, no shape
  check); interpreter only checks top-level arrays exist.
- Unlike Stripe (`stripe.ts:99-107,143`), Finch (`finch.ts:70-77`), and doc-obligation
  (full validator), Plaid does no per-object runtime guard. A transaction missing
  `transaction_id` passes `undefined` into a parameterized query, throwing an obscure
  pg error that (per T2-20) drops the rest of the batch. Fix: add per-object type
  guards and skip malformed individual records.

#### T2-22 (MEDIUM), Content-keyed obligation dedup can silently merge distinct obligations
- Location: `services/ledger/src/service/writes.ts:472-560` (`upsertObligationRow`
  dedups on counterparty_id/type/amount_due/currency/due_date, no natural key).
- Two genuinely distinct obligations sharing that tuple (two same-day disputes for the
  same amount, coinciding payroll runs) collapse into one row (`created:false`),
  under-reporting a real payable/receivable. The canonical path correctly keys on the
  provider's natural id. Fix: accept an optional external/natural key and prefer it.

#### T2-23 (MEDIUM), No DB uniqueness backstop for the dedup keys
- Location: `ledger_counterparties` (`migrations/0002`) and `ledger_obligations`
  (`migrations/0007`) have plain indexes, not UNIQUE, despite the `writes.ts:1-18`
  header claiming `INSERT ... ON CONFLICT`. The writers do SELECT-then-INSERT.
- Correctness rests entirely on the normalize worker's advisory-lock single-flight. A
  second worker without the lock, a future direct-call path, or a lock bug would create
  divergent duplicate rows with no DB guard. (`ledger_accounts`/`ledger_transactions`
  DO have UNIQUE constraints.) Fix: add UNIQUE constraints and real ON CONFLICT.

#### T2-24 (MEDIUM), Stripe incremental pull can skip same-second objects at the watermark
- Location: `services/raw/src/adapters/stripe.ts:126-154` (commits max `created`, next
  pull filters `created[gt]` strictly). Stripe `created` is 1-second resolution, so an
  object created in the same second as the committed watermark but after the walk
  finished is permanently excluded. Fix: use `created[gte]` with idempotency-key dedup,
  or track seen-ids-at-watermark.

#### T2-25 (LOW), Money-formatting and currency-default hygiene
- `plaid.ts:142` uses float `Math.abs(tx.amount).toFixed(2)` (float rounding pitfalls)
  instead of the integer-cents path Stripe/Finch use. `services/ledger/src/projection/
  obligations.ts:204` defaults a malformed/non-ISO currency to `"USD"` (not just a
  missing one), a misclassification risk for non-USD tenants; a known-invalid currency
  should fail/quarantine, not silently become USD. INFO: the doc-obligation canonical
  projector validates type/amount more loosely than the legacy validator (DB CHECK
  mostly covers it), and Merge `payment`/`tax_rate` pages are ingested but never
  projected (completeness gap).

#### Bank-detail-never-persisted invariant

_HOLDS for manual entry and every connector path checked. Manual counterparty
create/edit rejects payment-rail fields (`PAYMENT_FIELD_RE` +
identity-only allowlist, `services/ledger/src/routes/index.ts:426-536`), the error
echoes field NAMES not values, and no request logger dumps bodies.
`ledger_counterparty_payment_instructions` stores only sha256 hashes computed inside a
DB trigger (the app never sees the raw value); `linked_accounts` is never written to a
non-empty value anywhere. Audit events log only hashed/short identifiers. Verified._

#### T2-26 (MEDIUM, flag for sign-off), Agent-trace redaction masks (not forbids) bank account numbers, and the raw blob is persisted
- Location: `services/execution/src/redaction.ts:40-43` (`account_number`, `iban`,
  `routing_number` -> `mask_last4`) vs `:62-75` (`card_number`/`cvv`/`pin`/`private_key`
  -> `forbid`). The file header states the raw, unredacted blob is persisted, encrypted
  at rest per-tenant, readable under `audit:incident_investigation`.
- VERIFIED. This is a narrower path than manual counterparty create (already rejected):
  if a user or agent types/relays a bank account number or IBAN into an agent tool-call
  payload, the raw value is captured in the encrypted trace blob (access-controlled, not
  plaintext, but persisted in the literal sense the invariant states). Not a violation
  of the documented counterparty contract, but the "never persisted anywhere" wording
  and the actual mask-not-forbid + encrypted-persist design diverge. Needs a
  product/security decision: either forbid bank account numbers like card numbers, or
  document that they are encrypted-persisted under incident scope.

#### BrainMVB platform

Positives verified: the core-leads-client-follows invariant HOLDS (every brain-core
endpoint BrainMVB calls exists in brain-core code, including the 404/422/501-tolerant
extract route); no manually entered bank detail is persisted client-side (manual vendor
create is identity-only and the BFF re-filters to an allowlist); tenant and approval
actor are derived server-side (no client-supplied tenant_id is trusted anywhere in
client/src); secrets stay server-side; and error handling is strong (a single
approval-rejection reason map, consistent isLoading/isError/success states, verbatim
brain-core error relay).

#### T2-27 (HIGH), Plaid/Stripe integration routes have no auth and share a hardcoded DEMO_USER
- Location: `/Users/damon/BrainMVB/server/routes.ts:548` (`const DEMO_USER = "demo-user"`)
  and the routes at `:550,559,605,612,622,644,696,941` (none use `requireAuth`, while
  document/rules routes at `:728,737,909` do).
- VERIFIED. `POST /api/integrations/plaid/exchange` lets any UNAUTHENTICATED caller link
  a real Plaid bank account into the single shared `demo-user` bucket, and any other
  unauthenticated caller can list (`institution_name`, account masks) or `disconnect`
  it. Real functioning code, not a stub; the comment acknowledges it is prototype-only.
  Must gain `requireAuth` + `req.session.userId` scoping before shipping beyond a
  single-operator demo.

#### T2-28 (HIGH), Fabricated settled-payment rows are always injected into the live activity feed
- Location: `/Users/damon/BrainMVB/client/src/pages/ActivityPage.tsx:286-300`
  (`ADOBE_SETTLED`, `COMCAST_SETTLED`, `MERIDIAN_RECEIVABLE_SETTLED`, `GUSTO_RECON_SETTLED`
  from `mockProposals.ts`).
- VERIFIED. The comment states they "always appear in the 'Brain Did' tab regardless of
  what brain-core returns." A real/production tenant with zero completed payments sees
  four fabricated "Brain paid X" rows with no demo/example marker; no `synthetic` flag
  exists in the type system to distinguish them. Fix: gate behind a demo-mode flag and
  render an explicit Example badge.

#### T2-29 (MEDIUM-HIGH) / T2-30 (MEDIUM), Empty live tabs silently backfilled with fake data
- `AuditLogPage.tsx:121-136` backfills an empty tab with `DEMO_AUDIT_RECORDS` with no
  indicator: materially misleading on the compliance-facing decision-history surface for
  a tenant genuinely clean in a category. `VendorsPage.tsx:284-298` backfills an empty
  vendor trust tab with one fake vendor (correctly gated behind isLoading/isError, so no
  flash-of-fake, but a real empty category still renders a fake vendor). RulesPage and
  Add-Vendor are clean (no silent fallback).

#### T2-31 (LOW-MEDIUM), Full PAN/CVC captured via a non-tokenizing form that no-ops
- Location: `/Users/damon/BrainMVB/client/src/components/BillingModals.tsx:188-295`,
  `SettingsPage.tsx:778-786`. The subscription-billing card form captures full card
  number, expiry, and CVC into React state; only the last 4 are kept and nothing is
  transmitted or persisted (safe today). But it is a custom non-tokenizing input; if ever
  wired to a processor, replace with a tokenizing SDK (Stripe Elements) before any
  network call. LOW: `web3.ts:5` embeds the Alchemy key in the client bundle (standard
  Vite pattern; verify domain-restriction), and `server/auth.ts:83` falls back to a
  boot-time random `SESSION_SECRET` (multi-instance session-consistency footgun).

### Tier 2 verdict

The four public workflows are, structurally, propose-only sound (no module can call
`.execute()`; money still requires the gate and the Tier 0/1 approval floors), and two
hard invariants hold well: BrainMVB never calls a brain-core endpoint that does not
exist (core leads, client follows), and manually entered bank details are not persisted
through the manual-counterparty or connector paths. But two themes dominate:

1. The workflows are largely SCAFFOLDING with UNENFORCED GATING (T2-7 Collections/Cash
   not implemented; T2-13/T2-14/T2-15 the agent-output confidence/evidence/risk
   primitives are defeated on the live path; T2-16 vendor_risk cannot tell risky from
   clean; T2-18 fraud_anomaly computes no score). They cannot be presented as shipped,
   and their safety today rests entirely on the downstream gate, not on the agents.
2. Real correctness/money-integrity gaps in the data layer: T2-1 (reconciliation-linked
   duplicate obligations can both be paid, a genuine double-pay path), T2-20 (legacy
   ingestion silently and permanently drops failed records), and T2-2 (already-paid
   obligations corroborate confidence). T2-27/T2-28 in BrainMVB (unauthenticated bank
   linking; fabricated settled payments shown as real) are the platform-side headliners.

Priorities before this tier can be called production-ready: T2-1 (double-pay),
T2-20 (silent ingestion loss), T2-27 (unauth bank linking), T2-28 (fabricated activity),
then the agent-gating cluster (T2-13/14/15) and the confidence/dedup items. T2-26
(bank-detail-in-trace) needs a product decision. Overall Tier 2 readiness: NOT
production-ready; the money path is gated, but the workflows are demo-grade and the
ingestion + reconciliation + platform layers have real correctness and trust-boundary
gaps.

