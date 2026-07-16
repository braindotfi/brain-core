# Brain Full Code Review

Findings accumulate here across tiers. Each tier is audit-only unless a fix is
explicitly requested. Severity scale: critical / high / medium / low / info.

---

## Tier 3: Surfaces + Skills

Repo: braindotfi/brain-core. Findings sourced from branch
review/tier-3-surfaces.

### Fix status

- [x] T3-7 fixed: Slack and Teams approval prompts now sanitize
      proposal-derived title, claim, evidence label/value, and action summary before
      rendering. Slack mrkdwn escapes ampersand and angle bracket characters; Teams
      card text escapes markdown metacharacters.
- [x] T3-8 fixed: `handleSlackInteraction` requires an installation verifier,
      making omission of the Slack workspace to Brain tenant check a compile-time
      error.
- [x] T3-9 fixed: the public Teams submit helper requires a server-trusted Brain
      tenant id and rejects unsigned Adaptive Card tenant mismatches before building
      an incoming decision.
- [x] T3-10 fixed: smoke proposals fail closed when enabled without
      `BRAIN_SURFACE_SMOKE_SECRET`, and request secret comparison uses
      `timingSafeEqual`.
- [x] T3-11 fixed: surface proposals can carry canonical payee identity and the
      surface decision gate rejects self-approval with `self_approval_blocked`.
      Employee, payroll, and other payees fail closed when email identity is
      unresolved. Vendor payees with unresolved email retain the documented v1
      residual until canonical vendor identity links are first-class. Per-item
      limits and distinct second approver enforcement remain core/customer
      responsibility for surfaces in v1.
- [x] T3-12 fixed: the surface gateway audit pool can use
      `BRAIN_SURFACE_GATEWAY_AUDIT_DB_URL`, backed by `brain_surface_audit_writer`
      with INSERT-only access to `audit_events`.
- [x] T3-13 fixed: approval quorum matching treats the `signer` sentinel as any
      distinct concrete approver role, so `["signer", "signer"]` can be satisfied
      by two different concrete approver roles.
- [x] T3-14 covered: the gateway test suite pins the Teams AAD tenant to Brain
      tenant mismatch as a 403 and the reusable helper now enforces the same
      boundary.

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

## Tier 4: Docs + Listing + Access

Repos: braindotfi/brain-core, braindotfi/brain-skills (MCP listing copy at
/Users/damon/brain-skills), and braindotfi/BrainMVB (at /Users/damon/BrainMVB).
Branch: review/tier-4-docs-access. Scope: compare README / architecture docs /
CLAUDE.md in each repo against what the code actually does (flag stale/aspirational
claims); review the MCP marketplace listing copy (official.md / community.md /
agensi.md) against the confirmed propose-only skill behavior; spot-check any
investor materials present locally; confirm copy rules; and flag org-member/access
review as a manual item. Includes the final cross-tier rollup. Audit only.

### Checklist

- [x] brain-core docs vs code: T4-1..T4-9 (overstated maturity, gate count, contracts, broken quickstart)
- [x] brain-skills MCP listing copy vs confirmed propose-only behavior: disciplined; T4-10, T4-11
- [x] BrainMVB docs vs current (post-fix) state: T4-12..T4-17 (stale/dead-code claims)
- [x] Investor / whitepaper materials spot-check: none found locally (manual item)
- [x] Copy rules across all public docs: emojis/ampersands in brain-core (T4-9) and BrainMVB (T4-17)
- [x] Org member / access review manual action item (recorded above)
- [x] Final cross-tier rollup + overall readiness rating (below)

### Manual action items (cannot be verified from code)

- ORG ACCESS REVIEW: this review cannot verify GitHub org membership, repo
  collaborator permissions, Slack workspace admins, or cloud-provider IAM from
  inside the repos. Damon must review directly: braindotfi GitHub org members and
  per-repo access (who can push to main / merge PRs / manage secrets), the deploy
  VM SSH key holders (`VM_SSH_KEY_STAGING`, `VM_SSH_KEY`), GHCR/registry access,
  and any shared secrets (Slack/Teams/ESP/OpenAI keys, `BRAIN_PLATFORM_SERVICE_SECRET`).
- INVESTOR MATERIALS: no whitepaper / one-pager / pitch deck was found in any of the
  three local repos, so the Tier 4 brief's investor-claim spot-check could not run.
  If those materials exist elsewhere, re-run the ERC-4337 / contract-inventory /
  gate-count checks against them; the ground truth to check against is in the rollup.

### Findings

The dominant Tier 4 theme: the docs and public copy describe a TARGET / future
posture as if already SHIPPED. Tiers 0-3 established the real posture (testnet-only,
not ERC-4337, single EOA signer, single global credential key, Docker-VM deploy).
Several docs contradict that, and would mislead a customer, investor, or auditor.

#### brain-core docs

#### T4-1 (HIGH), Docs present the target security/deploy posture as shipped
- ERC-4337 smart account: `Brain_MVP_Architecture.md:549,674` ("ERC-4337
  BrainSmartAccount pattern", "ERC-4337 smart account owned by the tenant") and
  `concepts/proof.md:93` ("BrainSmartAccount | Validates UserOps"). The contract has
  NO EntryPoint / UserOperation / paymaster; the holder calls `executeViaSessionKey`
  directly (Tier 0 ground truth). The doc's own interface block contradicts its prose.
- Base mainnet as the current primary execution environment:
  `architecture/system-overview.md:96` and `Brain_Engineering_Standards.md` §11.1-11.3
  ("Base mainnet"). No contract has a mainnet address; all are Base Sepolia,
  unaudited (`SECURITY.md`, `contracts/audit-status.json`). `readiness-summary.md`
  correctly says testnet-only, so the doc set contradicts itself.
- 2-of-3 multisig publisher (`Brain_MVP_Architecture.md:641`,
  `Brain_Engineering_Standards.md:578`) and HSM anchor keys
  (`architecture/security-and-compliance.md:65`, `risks-and-mitigations.md:65`)
  stated as current fact. Actual signer is a single EOA (`SECURITY.md`); multisig
  rotation is a pre-mainnet TODO.
- Azure Container Apps / manual promote / "Azure OIDC secrets pending" deploy model
  (`Brain_Engineering_Standards.md` §11, `architecture/enterprise-readiness.md:29,133`,
  `HARDENING-SUMMARY.md:149`). The real deploy is Docker VM + GHCR, automated on green
  main; the manual promote is retired. enterprise-readiness.md presents an
  already-automated deploy chain as an unstarted external blocker (diligence-misleading).
- Suggested fix: sweep these to describe the actual shipped posture, and clearly mark
  mainnet / multisig / HSM / Azure items as PLANNED, not current.

#### T4-2 (HIGH), Tenant-scoped DEK/KEK envelope encryption is claimed but not implemented
- Location: `concepts/memory.md:76` and `architecture/security-and-compliance.md:7`
  ("Tenant-scoped DEKs wrapped by tenant-scoped KEKs in Azure Key Vault").
- VERIFIED: no DEK/KEK envelope scheme exists (zero repo hits). The actual mechanism
  (`shared/src/crypto/credential-key-provider.ts`) is a SINGLE global AES-256-GCM key
  (one Key Vault secret or a dev env var) used only to encrypt source credentials, not
  a tenant-scoped, general memory-encryption layer. This overstates the tenant-isolation
  architecture, which is exactly the kind of claim a security-evaluating customer or
  auditor relies on. Fix: describe the actual single-key credential encryption and drop
  the DEK/KEK envelope claim (or implement it before claiming it).

#### T4-3 (HIGH), The public developer quickstart is broken
- VERIFIED: `README.md:29,93,97` and `introduction/quickstart.md:15,45` install/import
  `@brain/sdk`, but the real published package is `@brainfinance/sdk`
  (`clients/sdk/package.json:2`); a developer copy-pasting gets an npm 404.
  `introduction/quickstart.md:50` calls `brain.sources.connect(...)` which does not
  exist in the SDK, and `:32` names `api.sandbox.brain.fi` which the SDK explicitly says
  does not exist. The "five minutes to a working integration" flagship sample cannot
  run. Fix: correct the package name, the resource, and the host to what the SDK ships.

#### T4-4 (MEDIUM), The gate check-count is wrong and inconsistent across docs
- Ground truth (`shared/src/gate/gate.ts`): 23 numbered checks. Correct in
  `CLAUDE.md:59`, `concepts/policy.md:60`, `architecture/enterprise-readiness.md`.
  Wrong in `SECURITY.md:11` and `architecture/readiness-summary.md:12` ("22", missing
  6.7), `architecture/write-paths.md:63` and `Brain_Engineering_Standards.md` §6.2
  ("17", omitting six real checks 3.5/5.5/6.5/6.6/6.7/8.5), and
  `Brain_MVP_Architecture.md:378,380` ("16"). The 17-count doc
  (Brain_Engineering_Standards) is the one §14 tells engineers to treat as
  authoritative, so it is the most consequential. Fix: single-source the count from
  gate.ts.

#### T4-5 (MEDIUM), Contract inventory inconsistent (four vs six)
- `architecture/system-overview.md:52-59`, `Brain_MVP_Architecture.md:604`, and
  `Brain_Engineering_Standards.md:70` list four contracts, omitting BrainEscrow and
  BrainReputationRegistry (both deployed to Base Sepolia and used at runtime).
  `enterprise-readiness.md` and `readiness-summary.md` correctly list six. Fix: list all
  six consistently.

#### T4-6 (MEDIUM), Policy-outcome docs omit the hard human-approval floor
- `concepts/policy.md:9-17` ("auto ... runs immediately ... There is no override. There
  is no bypass.") and `concepts/agents.md:60-62` present a simple allow-or-approve
  binary. This omits the Tier 0/1 hard floor: a policy allow on onchain_transfer /
  escrow_release / wire does NOT run immediately; a human approval is still required.
  Fix: document the rail-dependent hard floor and the signed-cap autonomous carve-out.

#### T4-7 (MEDIUM), data-flow.md overstates cryptographic guarantees on the approval path
- `architecture/data-flow.md:98,111` ("policy verdict, signed by Brain policy verifier
  key", "Approves with EIP-712 signature"). No per-evaluation verifier-key signature
  exists; the human approval is a database-recorded approval from an authenticated
  member session, not a wallet EIP-712 signature. Fix: describe the actual approval
  recording.

#### T4-8 (LOW-MEDIUM), Assorted brain-core doc inaccuracies
- `Brain_Engineering_Standards.md` §3.2 states the scope literal `agent:propose`; the
  real scope string is `execution:propose` (`shared/src/auth/scopes.ts`). Surface
  approval ordering is inverted in `architecture/surface-approval-adapters.md:43-51`
  (claims terminal-claim before audit; actual is audit-before-claim).
  `enterprise-readiness.md` undercounts production boot fences (five vs 7+). Reputation
  is described as "not on-chain in the MVP" while `BrainReputationRegistry` is deployed
  and read (though its scoring is a neutral placeholder). `concepts/proof.md:47` claims
  severity-accelerated anchoring; the cadence is flat hourly.

#### T4-9 (LOW, copy rules), Pervasive emojis and stray ampersands in brain-core docs
- Emojis are systemic across the GitBook-style docs (README, SUMMARY, concepts/*,
  architecture/*, HARDENING-SUMMARY), and `CLAUDE.md:5` itself ("## (warning-emoji)
  Dev environment") violates the no-emoji rule stated in CLAUDE.md's own Copy section.
  Non-brand ampersands ("Q and A", "decide and execute") appear in several docs. Fix:
  strip emojis and non-brand ampersands to match the repo copy rule.

#### brain-skills / MCP listing

#### T4-10 (MEDIUM-HIGH), The on-chain scope-verification claim omits testnet-only / unaudited status
- VERIFIED on merged `origin/main`: `README.md:64` ("verifies the agent's scope on
  chain"), `_shared/brain-mcp.md:21,40-41`, and `docs/security-review.md:145` describe
  the `scope_hash` verification against `BrainMCPAgentRegistry` with no disclosure that
  the registry is Base Sepolia testnet-only and unaudited (`viemScopeChecker` hardcodes
  baseSepolia). A marketplace reviewer would infer a mainnet-grade guarantee. The
  mechanism is real and enforced; only the maturity disclosure is missing. Fix: append
  a testnet/pending-audit qualifier at each location.

#### T4-11 (MEDIUM), security-review.md undercounts the MCP write surface
- VERIFIED: `docs/security-review.md:42` ("limits writes to Brain's two proposal
  tools") is wrong; the real mutating surface is agent.action.propose,
  payment_intent.propose, payment_intent.cancel, and raw.contribute. The tool TABLE was
  already corrected (Tier 3 T3-5); this security CLAIM was not. Fix: reword to the real
  write surface.
- Note: the Tier 3 doc fixes for the tool table (T3-5) and STATUS.md em dashes (T3-6)
  are already merged; the marketing/listing copy itself is disciplined (no autonomy
  overstatement, per-skill claims accurate, three variants consistent).

#### BrainMVB docs

#### T4-12 (HIGH), HANDOFF.md / next-steps.md present the "propose" flow as committed and working; it is dead code
- Location: `HANDOFF.md:57-106`, `next-steps.md:11-35`.
- The "Let Brain pay -> policy gate decides" flagship is documented as built, verified
  end-to-end, and committed. Reality: a later UI redesign removed the propose button;
  the current BrainBillsInbox / BillDetailPopup have no propose entry point and no call
  to `POST /api/brain/propose`, and `intentsStore.addProposed` has zero callers. The
  server route survives but is unreachable from the UI. Fix: restore an entry point or
  document that the feature regressed to non-functional pending re-wiring.

#### T4-13 (HIGH), deliverables/*.docx describe a removed Crossmint + WireX architecture as current, with no staleness notice
- The two migration .docx deliverables state "real cards, real bank accounts, real
  stablecoin balances (Crossmint + Wirex)" as the current architecture. Both
  integrations were fully removed from the codebase (zero repo hits). The docx files
  carry no internal stale-dated banner (only referenced as stale elsewhere), so anyone
  handed the deliverable (investor / new hire) is told BrainMVB provisions real FDIC
  bank accounts and debit cards, which is false. Fix: add a stale banner inside the
  docx or replace them.

#### T4-14 (MEDIUM-HIGH), server/brain/README.md claims the BFF is "GET-only" but it has write routes
- `server/brain/README.md:39,61-63` ("GET-only passthrough", "GET reads only"). The BFF
  registers 16 routes including POST /propose, /reject, /tenants, /invites/consume,
  member mutations, and /payment-intents/:id/approve. Stale on current origin/main (not
  just the local checkout). Understating a money-adjacent BFF's write surface as
  GET-only is exactly the drift that causes a reviewer to skip auditing the write paths.
  Fix: list the actual write routes and their auth model.

#### T4-15 (MEDIUM-HIGH), Cross-repo contradiction on production agent-token status
- BrainMVB `CLAUDE.md:369` and `replit.md:69` state "Contract CONFIRMED LIVE on
  api.brain.fi 2026-07-14" for the production `POST /v1/tenants` + agent-token flow.
  brain-core's own CLAUDE.md deployment-status table lists the same feature (production
  agent principals) as Pending / not on staging / not on prod. One is stale. An
  integrator trusting BrainMVB's docs would believe production agent tokens work in prod
  when brain-core says they do not yet. Fix: reconcile and update whichever is wrong
  (this is also a post-deploy-probe discipline item).

#### T4-16 (MEDIUM), BrainMVB status docs are stale
- `replit.md` still lists Audit Log as MOCK-ONLY though the merged Tier 2 fix made it
  live-only. HANDOFF.md / next-steps.md are ~3 weeks stale and describe long-merged,
  pushed commits as "not pushed" / "not yet committed". Fix: refresh or retitle as dated
  historical snapshots.

#### T4-17 (LOW, copy), BrainMVB copy style differs from the org convention
- BrainMVB docs use em dashes (65+ in CLAUDE.md), non-brand ampersands, and a few literal
  emojis. BrainMVB states no internal no-em-dash rule, so these are stylistic, flagged
  only for org-wide consistency with brain-core's enforced convention.

_Process note: the brain-skills and BrainMVB local clones are a commit behind
origin/main and show pre-fix state on disk. Run `git pull` on each before reading the
local trees. Not doc bugs, but a real trap for a reviewer reading the checkout._

---

## Cross-tier rollup and overall readiness

All fund-safety-critical findings surfaced by this review (Tiers 0-3) were fixed and
independently re-verified. What remains is product depth, deferred hardening, one design
decision already resolved, and a large documentation-accuracy gap.

### Prioritized state across all tiers (post-fix)

- CRITICAL open: none. Every HIGH fund-safety finding was fixed and verified: the
  session-key cap-denomination bug (T0-1), the propose-only hard-approval floor (T0-11),
  the silently-broken audit-anchor sweep (T1-20/21), the agent kill-switch hole (T1-4),
  the reconciliation double-pay path (T2-1), the silent ingestion loss (T2-20), the
  BrainMVB unauth bank-linking and fabricated activity (T2-27/28), and the surface
  spoofed-approval-prompt and self-approval gaps (T3-7/T3-11).
- Money path (off-chain gate + approval + RLS + surfaces): SOUND and fail-closed. Single
  execution choke point, audit-before-execute ordering, no tenant-omission bypass, no
  surface shortcut around approval, no inbound-content-steers-a-decision path.
- On-chain rail: intact-by-fence. Contracts are unaudited and testnet-only; the mainnet
  escrow fence is fail-closed and non-bypassable. NOT ready for value-bearing mainnet by
  design, and the fence correctly holds the line.
- Open items are non-fund-safety: Tier 2 workflows are demo-grade (Collections/Cash
  scaffolding, T2-7; fraud scoring unimplemented), Tier 2 connector hardening deferred
  (natural-key/UNIQUE at projection cutover), the two Tier 3 LOW advisories (shared
  normalizer extraction, audit-role config dependency), and the Tier 4 doc-accuracy gap.

### Overall readiness rating

- Security architecture and gating layer: STRONG. This is the most trustworthy part of
  the system; the fail-closed posture holds under adversarial review, and the team fixed
  every real defect quickly and correctly.
- Product workflows: DEMO-GRADE. Invoice is partially real; Collections, Cash, and fraud
  scoring are scaffolding. Not launch-ready as shipped capabilities.
- Documentation and public/marketplace/investor copy: NOT READY. It materially overstates
  maturity (mainnet, ERC-4337, multisig, HSM, tenant-scoped encryption, Azure) and has
  broken developer-facing content. This is now the single highest reputational and
  diligence risk, and it should be corrected before any external, investor, or
  marketplace exposure.

Overall: a strong, genuinely fail-closed security foundation with a trustworthy money
path, wrapped in workflows that are still demo-grade and documentation that oversells the
current state. Gate the go-to-market on (1) the external contract audit before any
mainnet value, (2) real Collections/Cash implementation before presenting all four
workflows as shipped, and (3) a documentation-accuracy pass (T4-1 through T4-15) before
any customer, investor, or marketplace sees the docs.

