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
- [x] Group B defense-in-depth fixed: executable PaymentIntent action types now
      come from one allowlist shared by the HTTP route, MCP tool, MCP resource,
      and service. `other` and unknown action types are rejected at create time,
      and `railFor` fails closed instead of defaulting to `bank_ach`.

### Tier 1 verdict update

The mergeable core HIGH defects from the Tier 1 review are fixed. Audit sweep
observability no longer fails silently, and halted agents can no longer dispatch
already-queued outbox rows after the worker observes quarantine. P3 fail-closed
hardening, P5 route hygiene, P4 DB least-privilege items, the API FORCE RLS gap,
the outbox guard boot fence, and the operator restore route are fixed. Group B
is also fixed: fiat rails now match the x402 signed-cap autonomy model where
applicable, production confidence-floor lint is wired at activation, and the
old H-09 contribution intake wording has been replaced by contribution hold.
The follow-up rail-routing hardening also closes the latent fail-open-by-
omission path where an unlisted action type could have reached a money rail.

---

## Tier 2: Workflows + Platform

Repo: braindotfi/brain-core. Source review branch:
review/tier-2-workflows-platform. Scope: workflow logic, agent-output gating,
legacy ingestion, reconciliation, and connector correctness.

### Fix status

- [x] T2-1 fixed: duplicate-payment detection now follows the confirmed
      `obligation_duplicate` reconciliation match graph and rejects a payment
      when any linked obligation observation is already paid or has an executed
      payment intent.
- [x] T2-2 fixed: independent obligation observations used for corroboration
      now exclude `paid` and `cancelled` rows.
- [x] T2-20 fixed: legacy normalization now retries failed rows until a bounded
      attempt budget, then quarantines and emits
      `brain.ledger.normalize.quarantined.count`. Stripe and Finch extractor
      loops skip per-object write failures instead of dropping the rest of the
      batch.
- [x] T2-21 fixed: Plaid normalization validates each account and transaction
      object at runtime and skips malformed records while continuing the batch.
- [x] T2-13 and T2-12 fixed: the event-driven agent route path now gathers the
      selected agent's required evidence and enforces `notify_only` or `reject`
      execution modes before any proposal is created. `/agents/run` enforces
      the same no-proposal behavior.
- [x] T2-14 fixed: `PolicyService.evaluateLegacy` threads `agent_id`,
      `confidence`, `evidence_score`, and `risk_level` into the VM action so
      agent-output policy primitives gate non-financial agent proposals.
- [x] T2-15 and T2-11 fixed: payment and treasury money proposals set intent
      `confidence` from the gathered evidence score instead of relying on the
      PaymentIntent default.
- [x] T2-16 and T2-17 fixed: vendor risk escalation now requires explicit risk
      indicators, and `require_approval` can escalate to `block_payment` when
      those indicators are present.
- [x] T2-19 fixed: payment and treasury handlers reject missing ids, malformed
      decimal amounts, and malformed currency values before building a payment
      intent.
- [ ] T2-7 remains product scope: Collections and Cash still need real dunning,
      forecasting, and sweep algorithms.
- [ ] T2-8 remains product scope: Collections still needs real message-variable
      population instead of the shared fallback proposal shape.
- [x] T2-9 fixed: both agent propose paths now fail closed as `missing_evidence`
      when the selected evidence bundle reports `critical_missing`, even if
      routing allowed the agent.
- [x] T2-18 partially fixed for review scope: the agent payload validator is now
      enforced before proposal creation, so malformed agent-channel payloads
      fail closed. Fraud anomaly scoring remains product scope.
- [x] T2-22 and T2-23 fixed: Ledger direct-write counterparty and obligation
      dedup now use database unique constraints plus `INSERT ... ON CONFLICT`.
      Obligation writes prefer connector natural keys where available.
- [x] T2-24 fixed: Stripe delta pulls re-read the committed watermark second
      with `created[gte]`, and existing idempotency keys absorb stable replays.
- [x] T2-25b fixed: projected obligations now reject malformed non-null
      currency values instead of defaulting known-invalid input to USD.
- [x] T2-26 fixed: bank account numbers, IBANs, and routing numbers are now
      forbidden in agent traces under the same policy path as card numbers.

### Tier 2 verdict update

The mergeable money-integrity core is closed for this pass: reconciliation-linked
duplicate obligations cannot be paid independently, settled obligations no
longer lift confidence, and legacy normalization no longer treats the first
failed row as terminal data loss. The main agent-output gating bypasses are also
closed for the live propose paths covered here: required evidence, execution
mode, confidence, evidence score, and risk level now reach the gates instead of
being advisory-only fields. The deferred connector integrity issues are now
closed with database-backed dedup, connector natural keys, Stripe same-second
watermark replay, and projection currency validation. Remaining Tier 2 work is
product-level implementation depth for Collections, Cash, and fraud anomaly
scoring.

---

## Tier 3: Surfaces + Skills

Repos: braindotfi/brain-skills (public skills, reviewed at /Users/damon/brain-skills)
and braindotfi/brain-core (Slack/Teams/email surface adapters). Branch:
review/tier-3-surfaces. Scope: every skill genuinely propose-only with no hidden
execute path; the skills drift check vs private definitions; OAuth against
mcp.brain.fi on every skill; SKILL.md accuracy; each surface adapter routing through
the same gate/approval layer with no shortcut; per-surface auth and tenant isolation;
and injection risks (inbound Slack/email/Teams content interpreted as an instruction
rather than data). Audit only.

### Checklist

- [x] brain-skills: every skill propose-only, no hidden execute path: PASS (CI gate scope T3-1)
- [x] brain-skills: drift check vs private definitions: PASS (shape gap T3-2/T3-3)
- [x] brain-skills: OAuth against mcp.brain.fi enforced on every skill: PASS
- [x] brain-skills: SKILL.md accuracy + copy rules: T3-3/T3-4/T3-5/T3-6
- [x] Surface adapters: route through the same gate/approval, no shortcut: PASS (stub enqueue + DB grants)
- [x] Surface adapters: approval authority server-side + idempotency: PASS, but weaker gate (T3-11)
- [x] Surface adapters: per-surface auth + tenant isolation: PASS (helper caveat T3-8/T3-9)
- [x] Surface adapters: token/signature verification: PASS (Slack/Teams/email all sound)
- [x] Injection: inbound content never sets which proposal/amount/recipient/tenant: PASS (canonical reload)
- [x] Injection: inbound free-text never reaches the agent/model/policy as an instruction: PASS
- [x] Injection: inbound content escaped in outbound approval prompts: FAILS for Slack/Teams (T3-7)
- [x] Final Tier 3 verdict (below)

### Findings

_Review in progress. Surface routing/auth findings still landing._

#### brain-skills (public MCP skills)

_Core safety invariant HOLDS, verified at the real implementation (not just docs):
the live MCP server exposes only reads plus `payment_intent.propose/cancel/list`,
`raw.contribute`, and `agent.action.propose`. There is NO execute/settle/sign/approve
tool anywhere (`services/mcp/src/tools/payment-intent.ts:4` states
`payment_intent.execute` is deliberately not exposed via MCP). brain-payment and
brain-treasury use only propose. OAuth against mcp.brain.fi is genuinely wired
server-side (RFC 9728 discovery, `services/api/src/well-known/oauth-protected-resource.ts`);
no credential is embedded client-side and the packaging scripts scan for leaked
key/bearer/PEM strings. The drift, invariant, and reference checks all pass._

#### T3-1 (MEDIUM), No-hidden-execute-path CI gate covers only 2 of 11 skills
- Location: `brain-skills/scripts/check-invariants.mjs:9,43-56`
  (`MONEY_MOVERS = new Set(["brain-payment","brain-treasury"])`).
- The forbidden-tool scan (`.execute`/`.settle`/`.sign`) only runs against the two
  money-mover skills; the other 9 skills' SKILL.md / brain-meta.json are never
  scanned for a hidden execute path. All 9 are clean today (manually verified), but
  the CI gate enforcing the core invariant is scoped to 2 of 11. Fix: broaden the
  forbidden-tool scan to all 11 skill directories.

#### T3-2 (MEDIUM), Drift check does not validate MCP tool-call shape
- Location: `brain-skills/scripts/check-drift.mjs` (compares only agent-definition
  metadata from `spec/brain-agents.json`, not tool argument schemas).
- No check compares the documented tool-argument shapes in `_shared/brain-mcp.md`
  against the real `inputSchema` in `services/mcp/src/tools/*.ts`, which is how T3-3
  went undetected. Fix: add a check that diffs the documented tool tables against the
  live tool inputSchemas.

#### T3-3 (MEDIUM), Documented agent.action.propose call shape does not match the real tool (9 of 11 skills)
- Location: `brain-skills/_shared/brain-mcp.md:68-78` (and the propose example in the
  9 non-money SKILL.md files) vs `services/mcp/src/tools/agent.ts:13-51`.
- VERIFIED. The docs document
  `{tenant_id, action_type, payload, linked_entities, idempotency_key}`, but the real
  tool accepts `{action: {kind, ...arbitrary}}` (tenant is derived from the JWT). A
  host calling exactly as documented gets `request_params_invalid`. Not a safety issue
  (still propose-only, still scope-gated), but every one of the 9 skills' public worked
  example fails against the live server. Fix: regenerate the tool tables from the real
  inputSchema.

#### T3-4 (MEDIUM), Documented idempotency_key replay-safety guarantee does not exist at the MCP boundary
- Location: `brain-skills/_shared/brain-mcp.md:65-66,78,94` claims every mutating call
  requires a caller-supplied `idempotency_key` cached 24h; grep of
  `services/mcp/src/{dispatcher,server}.ts` and the two mutating tools finds no
  idempotency handling. Either implement idempotency at the MCP mutating tools or
  remove the documented guarantee.

#### T3-5 / T3-6 (LOW), Doc-completeness and copy nits
- `_shared/brain-mcp.md` omits `payment_intent.cancel`, `payment_intent.list`, and the
  `raw.contribute` write tool from its tool table, while several SKILL.md files imply
  the doc is a complete contract. Copy: `spec/brain-agents.json:309` has an ampersand
  in a generated `display_name` ("Fraud & Anomaly", never surfaced in SKILL.md), and
  `brain-skills/STATUS.md:29,35,41` uses em dashes in internal headers (public repo
  root). No emojis, no other copy-rule violations in the skill copy.

#### Surface adapters: injection / content-as-instruction

_Core invariant HOLDS: the approval decision (which proposal, what amount/recipient,
who approved) never trusts attacker-suppliable content. Every surface reloads the
canonical Proposal server-side by (tenantId, proposalId) under RLS
(`services/surface-gateway/src/storage.ts:170-184` via
`packages/surfaces/src/core/approval.ts:47-56`); amount/recipient come from that
stored object, never the inbound payload. No inbound free-text (Slack/Teams message
text, email body/subject, display names) is forwarded to an LLM, agent-router, or
policy input anywhere. Webhook authenticity is sound: Slack whole-body HMAC with
timing-safe compare, Teams Bot Framework JWT + AAD-tenant->Brain-tenant resolution
with a mismatch 403, email HMAC single-decision recipient-bound token._

#### T3-7 (HIGH), Slack and Teams render agent-supplied content unescaped: spoofed approval prompt
- Location: `packages/surfaces/src/surfaces/slack/blockkit.ts:36,51` (`p.claim`,
  `p.action.summary` into unescaped `mrkdwn`) and
  `packages/surfaces/src/surfaces/teams/adaptivecard.ts:19,31` (`p.title`, `p.claim`
  into unescaped `TextBlock`s). Email escapes correctly
  (`packages/surfaces/src/surfaces/email/template.ts:37-65` via `esc()`).
- VERIFIED. The proposal `title`/`claim`/`evidence`/`action.summary` are built by the
  agent factories from finding fields that are vendor/counterparty-influenced (invoice
  vendorName, collections customerName, cash rationale, etc.). Slack mrkdwn renders
  `<https://evil|Click to release payment>` as a live link and Teams TextBlock renders
  `[label](url)` markdown, so an attacker who controls e.g. a vendor billing name can
  inject a clickable link or formatting into the approval card a human sees next to the
  real Approve/Hold buttons. It does NOT change what is approved (canonical reload is
  intact), but it is a genuine social-engineering / spoofed-UI vector against the
  approver. Fix: add a central `sanitizeForSurface` that escapes Slack mrkdwn
  (`&`,`<`,`>`) and Teams markdown metacharacters for every proposal-derived string
  before render, matching what email already does.

#### T3-8 (MEDIUM), Slack installationVerifier is optional and fail-open in the reusable library
- Location: `packages/surfaces/src/http/slack.ts:99-106`
  (`if (request.installationVerifier !== undefined)`).
- The cross-check that the decoded tenantId in the button's action_id corresponds to
  an ACTIVE installation for the sending Slack team only runs when a verifier is
  supplied; omit it and the handler trusts the tenantId embedded in the action_id. The
  gateway wires it correctly today (`services/surface-gateway/src/main.ts:134`), so
  production is not exposed, but this is a fail-open default in a package designed to
  be reused, and a refactor dropping the option loses the cross-tenant / uninstall
  revocation check with no type error. Fix: make `installationVerifier` required.

#### T3-9 (MEDIUM), Unused handleTeamsSubmit helper trusts submit.tenantId (cross-tenant hole if wired)
- Location: `packages/surfaces/src/http/teams.ts:47-56` (`toIncomingDecision` builds
  from `verified.submit.tenantId` with no check against the AAD-resolved Brain tenant).
- The production route (`services/surface-gateway/src/server.ts:565-603`) does NOT use
  this helper; it re-implements the flow inline and correctly checks
  `submit.tenantId !== installation.brainTenantId -> 403`. But `handleTeamsSubmit` is a
  public export of the surfaces package, and the Adaptive Card `data.tenantId` is plain
  unsigned JSON, so any consumer that uses the helper directly gets a cross-tenant
  approval hole. Fix: delete the helper, or make it require and enforce a server-side
  trusted Brain tenantId.

#### T3-10 (MEDIUM, config-dependent), Smoke endpoint fails OPEN without a secret
- Location: `services/surface-gateway/src/server.ts:664-676`
  (`if (opts.smoke.secret && header(...) !== opts.smoke.secret)`).
- VERIFIED. The auth check is guarded on `opts.smoke.secret` being truthy, so if smoke
  is enabled with NO secret set the 401 is skipped entirely and any caller can POST an
  arbitrary `Proposal` (any tenantId) and have it dispatched to a real tenant's Slack /
  Teams / email via the tenant's own installed bot. Combined with T3-7 (unescaped
  rendering), this is an unauthenticated fabricated-approval-card injection primitive
  for phishing an approver, if smoke is ever enabled without a secret. It does not
  bypass the approval gate itself. `BRAIN_SURFACE_SMOKE_ENABLED` defaults false and
  there is no "secret required when enabled" validation. Fix: fail closed (refuse boot
  or force disabled when enabled without a secret), and use `timingSafeEqual` for the
  compare.

#### Surface adapters: routing + approval authority + tenant isolation

_Core invariant HOLDS at code AND DB-credential level: the surface gateway CANNOT reach
a rail or execution_outbox. `SurfaceExecutionQueue.enqueueIdempotent`
(`services/surface-gateway/src/services.ts:173-180`) is a literal no-op, and the
`brain_surface_gateway` role (NOBYPASSRLS) has DML only on `surface_*` + approvals and
SELECT on users/members/policies, with no grant on `ledger_*` or `execution_outbox`
(`infra/db-roles.sql:222-232`). All three surfaces converge on the same
`ApprovalService.handle` ordering (expiry -> tenant-scoped identity -> policy re-check
-> audit-before-sign -> signature -> quorum -> atomic terminal-decision claim ->
execution enqueue) with no surface-specific shortcut. Terminal idempotency
(`ON CONFLICT (tenant_id, proposal_id) DO NOTHING` + crash-safe unapplied replay),
Slack timing-safe HMAC + stale-timestamp rejection + retry dedupe, Teams Bot Framework
JWT + AAD-tenant->Brain-tenant resolution, email HMAC single-decision recipient-bound
token, and RLS-scoped identity resolution (no client-supplied tenant/workspace trusted)
are all verified sound. (The Teams tenant cross-check T3-9 is the one place the shipped
gateway had to add a check the reusable helper omits.)_

#### T3-11 (MEDIUM, architecture), Surface approval gate has no self-approval / payee / per-item-limit check
- Location: `services/surface-gateway/src/services.ts:58-98`
  (`SurfacePolicyEngine.evaluateDecision`); `packages/surfaces/src/proposal/schema.ts`
  (no payee/counterparty field).
- VERIFIED. The surface approval gate checks only: active tenant policy exists, outcome
  is not reject, and the actor holds an approver role. It never enforces "actor is not
  the payee" or a per-item amount limit, unlike the core money-path
  `PaymentIntentService.approve` / `authorizeApproval`. It cannot: `ProposalSchema` has
  no payee identity (`action.payload` is opaque). Since a surface "approved" decision is
  the authoritative signal the customer's own ERP/bank acts on (the ExecutionHandoff
  contract), an approver who is the beneficiary can self-approve via Slack/Teams/email
  with no built-in block. Surface approvals do not drive core execution (the enqueue is
  a stub), so the risk is scoped to what the customer automates on the handoff signal,
  but the surface approval authority is materially weaker than the core money path. This
  should be an explicit, documented decision (v1 scope) rather than an implicit gap, and
  it is the same class of residual the core review already flags for vendor payees.

#### T3-12 (LOW), Surface gateway holds a broad brain_app DB credential alongside its least-privilege role
- Location: `services/surface-gateway/src/main.ts:55-60` opens `auditPool` on
  `DATABASE_URL` (the `brain_app` role, which has DML on all tables including
  `ledger_*`/`execution_outbox`, RLS-scoped) purely to call the audit emitter.
- No active exploit (audit emit is parameterized), but it undercuts the
  "gateway can only touch surface state + approvals" story at the credential level.
  Consider a dedicated `INSERT`-on-`audit_events`-only role for the gateway's audit pool.

#### T3-13 (LOW), Quorum-never-met for a policy that uses the generic "signer" sentinel
- Location: `services/surface-gateway/src/services.ts:211-220` (`firstMatchingRole`
  records the actor's concrete role) vs
  `services/execution/src/approvals/ApprovalService.ts:197-209` (quorum tests the
  literal required-role strings against the set of signed concrete roles).
- If a tenant policy expresses "any two distinct approvers" as
  `required_approvers: ["signer","signer"]`, the signed set contains concrete roles
  (`{"cfo","controller"}`) and never the literal `"signer"`, so quorum can never be
  met. Fails CLOSED (stuck-pending), so a reliability bug, not a bypass. Confirm whether
  surface policies use the `"signer"` sentinel; if so, dual-approval on those is blocked.

#### T3-14 (INFO), Test-coverage and accepted-tradeoff notes
- The Teams `submit.tenantId !== installation.brainTenantId -> 403` check
  (`server.ts:600-603`) is the single line standing between the shipped behavior and a
  cross-tenant approval forgery (see T3-9), yet has no regression test; add one. The
  email approval token is a bearer credential (a forwarded link lets anyone act as the
  verified recipient) - the standard, accepted magic-link tradeoff, noted as an inherent
  residual.

### Tier 3 verdict

The distribution surfaces are the strongest tier reviewed. The load-bearing invariants
all hold and are enforced at the real implementation, not just in docs:

- brain-skills is genuinely propose-only: no execute/settle/sign/approve tool exists
  anywhere in the MCP server, OAuth against mcp.brain.fi is properly wired, no
  client-side credentials, and the drift/invariant/reference checks pass.
- The surface gateway cannot move money: its execution port is a no-op stub and its DB
  role has no grant on ledger or outbox tables. All three surfaces route through one
  ApprovalService with correct ordering, terminal idempotency, and sound
  signature/token verification, and the approval decision never trusts
  attacker-suppliable inbound content (canonical proposal reloaded server-side; no
  inbound free-text reaches the agent/model/policy).

The findings are hardening, not fund-safety breaks. Priorities:
1. T3-7 (HIGH): escape agent-supplied strings before Slack/Teams render (spoofed
   approval prompt / link injection); email already does this.
2. T3-11 (MEDIUM): decide and document whether the surface approval gate should enforce
   self-approval/payee/limit like the core money path, or accept the weaker v1 posture.
3. T3-9 (MEDIUM): delete or fix the unsafe unused `handleTeamsSubmit` public helper (and
   T3-8 make the Slack installation verifier required), so a future integrator cannot
   reintroduce a cross-tenant approval hole; add the T3-14 regression test.
4. T3-10 (MEDIUM): make the smoke endpoint fail closed when enabled without a secret.
5. brain-skills docs: T3-3 (call-shape drift on 9 skills), T3-4 (unimplemented
   idempotency claim), T3-1/T3-2 (broaden the CI gates), and the copy nits.

Overall Tier 3 readiness: SOUND. No surface can move money or bypass approval, no
inbound content steers a decision. Fix T3-7 before relying on Slack/Teams approval
prompts with untrusted vendor data, and make the T3-11 self-approval decision explicit.

