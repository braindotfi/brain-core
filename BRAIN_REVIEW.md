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
Model: Opus 4.8. Scope: the pre-execution gate and its deterministic checks;
propose-only enforcement across every entry point (agent, API, MCP, surface
adapters); RLS policies and the audit-anchor sweep; confidence floor defaults at
provisioning; the trust state machine (grant / revoke / pause / restore); and DB
role separation. Emphasis on fail-closed vs fail-silent. Audit only.

### Checklist

- [x] Pre-execution gate: full check set, fail-closed vs degrade-to-not_applicable (T1-14, T1-15)
- [x] Dormant safety loaders: every check's loader guaranteed present in production (T1-16, T1-17; 7 always-on loaders fenced)
- [x] Group B hard-approval floor: adversarial bypass probe (no bypass; see gate positives)
- [x] Propose-only across every entry point (API, MCP, surface, agent): holds; see positives + T1-7, T1-8
- [x] Policy-bypass via omitted/spoofable tenant parameter across all endpoints: none found (intra-tenant T1-8 only)
- [x] RLS policy coverage + tenant GUC pool-leakage: no leak; GUC transaction-local (T1-23 low; positives)
- [x] Audit-anchor sweep fails loudly, not silently: FAILS SILENTLY (T1-20, T1-21, T1-22)
- [x] Confidence floor default set on every provisioning path + fail-closed enforcement (T1-1, T1-2, T1-3)
- [x] Trust state machine: transitions, races, partial-state failures (T1-4, T1-5, T1-6)
- [x] DB role separation: eight-role least-privilege, no role broader than needed (T1-9, T1-10, T1-11, T1-12)
- [x] Final Tier 1 verdict (below)

### Tier 1 verdict

The gating layer is structurally sound in its core guarantees: execution is a
genuine single choke point, tenant scoping is server-derived with no
omitted/spoofable-tenant bypass and no RLS leak (GUC is transaction-local), the
gate does not swallow loader exceptions, audit-before-execute ordering holds, the
seven always-applicable gate loaders are covered by the production boot fence, and
the Group B hard-approval floor survived adversarial probing. But two named past
bug classes recurred, one as an ACTIVE production defect:

1. T1-20 (HIGH): the audit-anchor reconciler runs its cross-tenant scan on the
   FORCE-RLS `brain_app` request pool, so in production it matches zero rows every
   cycle and the `orphan_detected` alert never fires. This is exactly the "RLS
   audit-anchor sweep silently failing in production" class, live today. T1-21
   (HIGH) and T1-22 (MEDIUM) compound it: cycle failures are swallowed log-only
   with no failure/heartbeat metric, and the health endpoint reports "safe" for a
   dead verifier. Net: the tamper-evidence anchoring can fail in production
   unobserved.
2. T1-4 (HIGH): the agent kill-switch does not stop in-flight dispatch and is
   non-atomic and mis-ordered, so a halted agent can still settle on-chain.

MEDIUM: T1-14 (on-chain gate checks key on optional context, not action_type, a
fail-silent skip that also lets autonomous x402 execute with recipient/asset
unvalidated), T1-1 (production tenants get no confidence floor; safe only via
fail-closed no-policy eval), T1-7 (the gate-bypass CI guard does not scan the
actual money-signing sinks), T1-9 / T1-10 (over-broad `brain_privileged` and
`brain_tenant_deletion` grants). Lows and info: T1-2/T1-3, T1-5/T1-6, T1-8,
T1-11/T1-12/T1-13, T1-15 through T1-19, T1-23.

Cross-tier: the propose-only-is-policy-conditional design question (T0-11) extends
to FIAT rails (a policy `allow` on ach/wire/card auto-executes with no approval);
this is design intent to confirm, not a new defect.

Overall Tier 1 readiness: the money path is well-gated at execution, but the
DETECTIVE control (audit-anchor integrity monitoring) is silently broken in
production and the agent kill-switch has a real hole. T1-20/T1-21 and T1-4 are the
priorities before relying on production audit-tamper detection or the kill-switch.

### Findings

_Review in progress. Findings land here as each area is verified._

#### T1-1 (MEDIUM, latent), Production POST /v1/tenants establishes no confidence floor (no policy at all)
- Location: `services/api/src/production-tenancy/routes.ts` (tenant-create tx, no
  policy insert) vs `services/api/src/onboarding/provision.ts:146,177` (self-serve
  inserts `buildDefaultPolicyDocument()` with `DEFAULT_CONFIDENCE_FLOOR = 0.6`).
- The confidence floor is not a DB/migration default; it is an
  `agent.confidence.gte` rule inside the tenant's active signed PolicyDocument,
  seeded per provisioning path. Self-serve seeds it; the production path creates
  the tenant, bootstrap admin member, identity link, and BFF agent but inserts NO
  policies row. Verified: grep of the production route shows no policy/seed insert.
- Safe today (fail-closed): with no active policy, `getActive`
  (`services/policy/src/repository.ts:78`) returns null and `evaluateForGate`
  (`services/policy/src/service.ts:62,133`) throws `policy_not_found`;
  `PaymentIntentService.create` does not catch it, so no intent can be created or
  executed against a floor-less production tenant. It fails closed, not open.
- Why it still matters: the "every fresh tenant has a 0.6 floor" guarantee was
  applied to self-serve only. The production population's safety rests entirely on
  the separate no-policy throw. If any permissive default policy or a `getActive`
  fallback were ever introduced, production tenants would be the exact under-gated
  population with no floor and nothing in provisioning to catch it. The floor is a
  per-path constant, not an invariant by construction.
- Note: seeding no default policy on production may be intentional (production
  tenants author and sign their own policy). If so, the real gap is that nothing
  guarantees that first signed policy CONTAINS a confidence floor.
- Suggested fix (not applied): either seed a default signed policy on the
  production path too, or enforce a minimum confidence-floor rule in the policy
  linter at activation, so a floor is guaranteed by construction rather than by
  remembering to set it per path.

#### T1-2 (LOW, non-production), Demo and golden-path seeds ship floor-less permissive policies
- Location: `services/api/src/demo/brainsaas-seed.ts:581-663` (`seedPolicy`) and
  `tools/seed-golden-path/src/cli.ts` (`DEMO_POLICY`).
- Both insert active policies with no `agent.confidence.gte` rule and catch-all
  `when:{} execute:auto` rules for `onchain_tx` / `agent_action`. A
  document-extracted obligation (confidence <= 0.5) driving an `agent_action`
  would match unconditionally and auto-allow with no floor. Contained: demo
  tenants are `kind='demo'`, sandbox/testnet only, never promotable to production,
  and the mainnet escrow fence blocks 8453; golden-path is a local dev fixture.
  Worth aligning these fixtures with the shipped self-serve floor so they are not
  mistaken for the reference default.

#### T1-3 (LOW, structural), No single choke point for the confidence-floor default
- The floor lives as `DEFAULT_CONFIDENCE_FLOOR` in `provision.ts` and is applied
  only where `buildDefaultPolicyDocument()` is called. A new provisioning path
  inherits nothing and can silently omit the floor, as the production and demo
  paths already show. The only backstop is the fail-closed `policy_not_found`
  throw, which covers the no-policy case but not a policy-present-without-floor
  case. Centralizing floor seeding (or linting for it at policy activation) would
  make it structural.

_Positive verified: policy evaluation fails closed on a missing active policy, and
the VM `agent.confidence.gte` operator fails closed on a missing/null confidence
(`services/policy/src/vm.ts:199-203`), so the original silent-pass bug cannot recur
through an absent policy or a missing confidence signal._

#### T1-4 (HIGH), Agent kill-switch does not stop in-flight dispatch; halt is non-atomic and mis-ordered
- Location: `services/api/src/main.ts:1738-1750` (`haltAgent`);
  `services/execution/src/payment-intents/PaymentIntentService.ts:896-922`
  (`pauseByAgent`, filters `status='approved'`);
  `services/execution/src/outbox/worker.ts:148-200` (only pre-dispatch guard is
  `audit_before_id` at `:162`).
- `haltAgent` runs two separate transactions in the wrong order: it
  `pauseByAgent` first (pausing only `status='approved'` intents), THEN quarantines
  the agent (`active -> quarantined`) in a second `withTenantScope`. Verified.
- Three failures, all confirmed against the code:
  - Post-gate escape: an intent that `execute()` already moved
    `approved -> dispatching` sits as a pending `execution_outbox` row. `pauseByAgent`
    never sees it (wrong status filter), and the outbox worker dispatches any row
    with a set `audit_before_id` WITHOUT re-checking agent state (worker.ts:162 is
    the only guard, then `rail.dispatch()` at :176). So money still moves on-chain
    after the operator hits the kill-switch.
  - TOCTOU race: because the agent is quarantined AFTER the pause, a concurrent
    `execute()` in the gap passes gate check 1 (agent still `active`,
    `gate.ts:466-472`) and moves an intent into `dispatching`, escaping the pause.
  - Non-atomic: a crash between the two transactions leaves intents paused but the
    agent still `active` (fail-open on agent state); it keeps proposing.
- Severity capped by contracts being testnet-only today, but as a safety-control
  correctness defect the kill-switch has a real hole.
- Suggested fix (not applied): quarantine the agent FIRST and pause in ONE
  transaction, and have the outbox worker re-resolve the creator agent's state and
  refuse to dispatch a row whose agent is `quarantined`/`revoked` (fail closed to
  `reconciling`). Verified-good: the ordinary revoke-between-propose-and-execute
  case IS blocked, because gate check 1 re-checks `state === "active"` every
  `execute()`.

#### T1-5 (MEDIUM), No reachable trust `restore` transition + "quarantine" naming collision
- Location: `services/execution/src/state-machines.ts:80` (permits
  `quarantined -> active`, but nothing calls it);
  `services/agent-router/src/agent-api.ts:194-224`.
- A kill-switched (`quarantined`) agent has no route back to `active` short of
  re-registration/DB surgery. Worse, `/agents/:id/halt` sets
  `agents.state='quarantined'` while `/agents/:id/quarantine/release` clears a
  DIFFERENT column (`quarantine_cleared_at`, the H-09 contribution quarantine), so
  an operator "releasing" a halted agent changes nothing about its state. Fails
  closed (stuck-denied), but an operability defect and operator-confusion footgun.
  Fix: add an explicit resume route that CAS-transitions `quarantined -> active`,
  and rename one of the two "quarantine" surfaces.

#### T1-6 (LOW/MEDIUM), api-key revoke bypasses the state-machine guard
- Location: `services/api/src/production-tenancy/api-key-routes.ts:217-220`.
- `UPDATE agents SET state='revoked' WHERE tenant_id=$1 AND id=$2` runs with no
  from-state guard and no `transitionAgent`, contradicting the state-machine's
  "only these helpers mutate state" invariant (it will flip a `failed` agent to
  `revoked`, an undefined transition). Security-safe (revoked = deny), but route it
  through the canonical guard so there is one writer.

#### T1-7 (MEDIUM), CI gate-bypass guard does not scan the actual money-signing sinks
- Location: `scripts/check-gate-bypass.mjs:32` (`SCAN_DIR = "services/execution/src"`)
  vs the signing sinks in `services/api/src/rails/onchainExecutor.ts:83`
  (`writeContract` -> `executeViaSessionKey`) and
  `services/api/src/rails/x402Client.ts:47` (USDC settle).
- The guard that enforces the single-choke-point invariant scans only
  `services/execution/src`, so the files that actually sign and submit funds are
  outside its coverage. The invariant holds today (those clients are only invoked
  by rail classes the worker dispatches), but a future direct call to
  `onchainExecutor.execute()` / the x402 client / a new `.dispatch()` from any
  `services/api` or `services/ledger` route would NOT be caught. Because Tier 0
  leaned on this guard as the enforcement of "one submission site," the blind spot
  weakens that guarantee. Fix: extend the guard to also scan `services/api/src/rails`
  (and assert those clients are imported only by rail classes).

#### T1-8 (LOW), Intra-tenant proposal attribution is spoofable via body agent_id
- Location: `services/execution/src/routes.ts:63`
  (`proposingAgent = request.body?.agent_id ?? principal.id`);
  `services/execution/src/payment-intents/routes.ts` (same pattern on create).
- `created_by_agent_id` is taken from an untrusted body field. Not a fund or
  cross-tenant bypass (tenant is server-derived, and gate check 1 requires
  `created_by_agent_id === principal.id` at execute, so a spoof fails closed), but
  it misattributes proposals to another agent within the same tenant. The MCP tool
  correctly forces `agent_id = ctx.agent.id`; the HTTP routes should match unless
  an admin scope is present.

#### T1-9 (MEDIUM), brain_privileged retains cross-tenant INSERT on audit_events (and blanket DML)
- Location: `infra/db-roles.sql:102-103` (blanket
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` to `brain_privileged`) vs
  `:243-247` (revokes only `UPDATE, DELETE, TRUNCATE` on `audit_events`).
- INSERT on `audit_events` survives the revoke, so a `brain_privileged` (BYPASSRLS)
  connection can inject forged audit rows for any tenant before anchoring, plus
  retains full cross-tenant DML on money-path tables. Exposure is capped because
  `brain_privileged` is seed-only and is NOT wired into any API runtime pool
  (verified: `main.ts` builds only the least-privilege pools), but it is the
  single broadest grant in the model. Fix: replace the blanket `ALL TABLES` grant
  with the seed's real table footprint, and add `INSERT` to the `audit_events`
  revoke for `brain_privileged`.

#### T1-10 (MEDIUM), brain_tenant_deletion is BYPASSRLS with broad DELETE across every RLS table
- Location: `infra/db-roles.sql:96` (BYPASSRLS) + `:218-224` (DO-loop
  `GRANT SELECT, DELETE` on every RLS-enabled table).
- Because it bypasses RLS, any erasure statement that omits or mis-binds the tenant
  predicate deletes across ALL tenants (fail-open cross-tenant delete). The
  in-file comment acknowledges this is the erasure concern. Erasure runs one tenant
  at a time and could instead be RLS-scoped like `brain_app` so a bug fails closed.
  Fix: RLS-scope the erasure worker, or assert an explicit tenant filter on every
  DELETE.

#### T1-11 (LOW), Unused DELETE grants on projector / raw-worker roles
- Location: `infra/db-roles.sql:153` (`brain_raw_worker`), `:162`
  (`brain_canonical_projector`), `:175` (`brain_ledger_projector`).
- These are append/upsert projectors; DELETE is likely never exercised. Grant only
  `SELECT, INSERT, UPDATE` unless a delete path is verified in the worker source.
  Defense in depth.

#### T1-12 (LOW, doc), Stale privilege claim in the outbox worker docstring
- Location: `services/execution/src/outbox/worker.ts:18-24` states cross-tenant ops
  run on `brain_privileged (BYPASSRLS)`, but the wiring uses the tighter
  `brain_execution_worker` pool (`main.ts:996,1022-1025`). The code is correct and
  tighter than the comment; update the comment.

#### T1-13 (INFO), Dead tenantId field on the action-create body type
- Location: `services/execution/src/actions/routes.ts:52` declares
  `CreateActionBody.tenantId?` but it is never read (scoping uses
  `request.principal.tenantId`). Safely ignored, but remove it so a client cannot
  believe it is honored.

#### T1-14 (MEDIUM), On-chain gate checks key on an optional context field, not action_type: fail-silent skip
- Location: `shared/src/gate/gate.ts:551` (check 3.5), `:640` (check 6.5), `:679`
  (check 6.6), and `isX402AutonomousAllowed` at `:369-381` (never inspects
  `intent.settlement`).
- Checks 3.5 (on-chain settlement permitted), 6.5 (x402 asset/network/recipient/
  amount match), and 6.6 (escrow state) only run when the intent carries
  `settlement`/`escrow` context (`if (input.intent.settlement !== undefined)`).
  But the dispatch rail is chosen by `action_type` alone (`railFor`,
  `PaymentIntentService.ts:1379-1397`). So an `x402_settle` with
  `settlement === undefined` routes to the x402 rail while 3.5 and 6.5 are
  silently skipped, and an `escrow_release` with `escrow === undefined` skips 6.6.
  The gate treats "no context" as "not an on-chain settlement," which is false for
  an on-chain action_type.
- Compounds with the Group B floor: `isX402AutonomousAllowed` grants autonomy from
  the policy cap + intent amount/currency WITHOUT requiring settlement context, so
  an `x402_settle` with an autonomous cap and no persisted `pay_to` executes
  autonomously (no approval) with the settled asset and recipient never validated
  by the gate. The context is enforced only at the HTTP route boundary
  (`routes.ts:161-181`); `create()` itself does not require it, so a non-route
  caller (invoice-shortcut / agent path) can mint such an intent.
- Suggested fix (not applied): make the gate fail closed on structural mismatch:
  for `action_type === "x402_settle"` require `intent.settlement` (else reject at
  6.5), for `escrow_release` require `intent.escrow` (else reject at 6.6), and have
  `isX402AutonomousAllowed` require settlement context present. Do not treat a
  missing context on an on-chain action_type as `not_applicable`.

#### T1-15 (LOW/MEDIUM), Check 3 is a blacklist: a non-canonical policy outcome fails open
- Location: `shared/src/gate/gate.ts:534-543` (check 3 rejects only on
  `matched_rule_id === null` or `outcome === "reject"`).
- The confirm-quorum branch fires only on `outcome === "confirm"` and the hard
  floor only on `outcome === "allow"`, so any `decision.outcome` that is neither
  `allow`/`confirm`/`reject` but carries a `matched_rule_id` passes checks 3, 10,
  and 11 with zero approvals and no floor. Reachability is low (the outcome is a
  typed three-value union written from policy eval), so this is defense-in-depth,
  but it is a whitelist-vs-blacklist fail-open against the stated "fail closed on
  any uncertainty" invariant. Fix: check 3 should require
  `outcome === "allow" || outcome === "confirm"` and reject anything else.

#### T1-16 (LOW), resolveTenantFlags (check 1.5) has no production boot fence
- Location: `services/api/src/composition/payment-loaders-prod-fence.ts` (omits
  `resolveTenantFlags`); wired unconditionally today at `main.ts:659-661`.
- No live exposure, but if a refactor made it conditional/absent,
  `requireBehaviorHash` would read `false` for every tenant (`gate.ts:487`),
  silently disabling behavior-hash pinning for a tenant that explicitly opted in: a
  fail-silent downgrade of a mandatory control with nothing to catch it at boot
  (unlike 5.5/8.5). Fix: add `hasResolveTenantFlags` to the fence.

#### T1-17 (LOW), Check 6.6 escrow-state binding relies on implicit env coupling, not a fence
- Location: `resolveEscrowState` wired iff `BRAIN_ESCROW_ADDRESS` set
  (`main.ts:771-778`); the escrow rail requires the same env to register. So today,
  whenever `escrow_release` can dispatch, the loader is present, and escrow_release
  also always hits the hard-approval floor and the mainnet escrow-audit-gate. But
  the safety rests on an env-var overlap, not an explicit invariant. Fix: assert
  "if the escrow rail is registered, resolveEscrowState must be wired."

#### T1-18 (LOW, info), Gate metric emission is not exception-guarded despite the "never fail a gate" contract
- Location: `shared/src/gate/gate.ts:413-430` (called at `failGate` and success);
  docstring at `:328` promises metric failures never fail a gate, but `emitMetrics`
  has no try/catch. A throwing metrics sink throws out of `runPreExecutionGate`.
  Fails CLOSED (execute aborts, no money moves), so not a security hole, but a
  liveness/DoS risk contradicting the documented contract. Fix: wrap emission in
  try/catch.

#### T1-19 (LOW, info), x402 and escrow rails have no typed receipt schema
- Location: `services/execution/src/outbox/receipts.ts:35-41`
  (`railKeyForActionType` returns null for `x402_settle` / `escrow_release`), so
  `validateRailReceipt` enforces nothing for the two newest on-chain rails,
  weakening the forensic-replay guarantee that onchain_transfer/ACH/wire have. Not
  a gate fail-open; a completeness gap.

_Gate positives verified: `runPreExecutionGate` has no try/catch and no loader
error is swallowed as a pass (every loader exception propagates and aborts execute
before enqueue); audit-before (check 13) is emitted after checks 1-12 and its id is
written into the outbox row in the same transaction as `approved -> dispatching`;
the seven always-applicable loaders (9.5, 11.5, 8, 5.5, 8.5, obligation confidence/
direction) are all covered by the production boot fence; and the Group B floor
survived adversarial probing (no action_type bypass, exact currency/decimal
matching, floor independent of `required_approvers`, create-vs-gate disagreement can
only strand an intent, never under-approve a dispatch). One residual: approval
staleness is enforced only when `decision.policy_version` is populated, which
production eval always does._

#### T1-20 (HIGH), Anchor reconciler runs its cross-tenant scan on the RLS-restricted request pool: permanent silent false-clean in production
- Location: `services/audit/src/reconciler.ts:58` (unscoped `deps.pool.query`) +
  `services/api/src/main.ts:1108` (passes the request `pool`).
- This is the named bug class ("RLS audit-anchor sweep silently failing in
  production"), and it is an ACTIVE production defect, not latent. The orphan scan
  enumerates cross-tenant with no tenant GUC set:
  `SELECT ... FROM audit_anchors WHERE onchain_tx_hash IS NULL AND onchain_status
  <> 'reverted'`. But it runs on the request-path `pool`, which connects as
  `brain_app` (NOBYPASSRLS, `infra/db-roles.sql`) and `audit_anchors` has
  `FORCE ROW LEVEL SECURITY` (`services/audit/migrations/0007`) with a
  `tenant_id = current_setting('app.tenant_id', true)` policy (`0002`). With
  `app.tenant_id` unset the predicate is `tenant_id = NULL`, so the scan matches
  ZERO rows every cycle and reports `{recovered: 0, flagged: 0}` success.
- Consequence: orphaned anchors (roots that never landed on-chain) are never
  healed, and the ops alert `audit.anchor.orphan_detected` never fires, in
  production. The tamper-evidence chain to Base is silently unmonitored.
- Damning corroboration: the SIBLING job `startAuditConsistencyVerifier` is
  deliberately handed the BYPASSRLS `auditVerifierPool` with an explicit comment
  (`main.ts:1121-1124`) warning that the request `pool` "would match zero rows and
  report a permanent false-clean." The reconciler needed the same treatment and
  did not get it. Not caught by tests: `reconciler.test.ts` uses a fake pool with
  canned rows, and dev/compose runs as a BYPASSRLS superuser, so it only fails in
  production.
- Suggested fix (not applied): pass a BYPASSRLS least-privilege reader pool to
  `startAnchorReconciler` (matching the verifier), and add an integration test that
  runs the scan under a NOBYPASSRLS role to prove non-zero visibility.

#### T1-21 (HIGH), Audit sweep cycle failures are swallowed log-only, with no failure counter or heartbeat
- Location: `shared/src/workers/managed-interval.ts:53-62` (catches and calls
  `onError`, loop never rejects); both audit workers pass a log-only `onError`
  (`services/audit/src/reconciler.ts:125`,
  `services/audit/src/audit-consistency.ts:527`).
- If an entire cycle throws (DB pool unreachable, checkpoint lock/query error, RPC
  failure, unhandled exception) the result is: no throw, no crash, no error-counter
  increment, no page. The consistency gauges are emitted only on the success path,
  so a throwing cycle leaves them STALE (dashboards see no spike). There is no
  per-cycle heartbeat / last-success gauge and no cycle-failure counter, so a
  verifier that crashes every cycle is indistinguishable from a healthy idle one.
  Same silent-failure shape as T1-20, one level up (whole loop vs one query).
- Suggested fix (not applied): increment a dedicated `cycle_failed` counter in
  `onError`, emit a `last_success_at` heartbeat each completed cycle, alert on
  staleness/absence, and escalate repeated consecutive failures.

#### T1-22 (MEDIUM), Audit health rollup ignores verifier staleness: a dead verifier reports "safe"
- Location: `services/api/src/audit-health/route.ts:53-68`
  (`deriveAuditHealthStatus`).
- The rollup escalates only on `lastPassStatus === "failed"`, open findings, or
  outbox exhaustion. `secondsSinceCleanFullPass` is computed and returned in the
  body but never used in the status. So if the verifier completes one clean pass
  then dies every cycle (T1-21) or stalls, `lastPassStatus` stays `"clean"` and the
  endpoint reports `status: "safe"` indefinitely while integrity is no longer being
  verified, misleading any alert keyed on `status`. Fix: factor staleness into the
  status (exceeding a few multiples of the interval -> degraded/critical).

#### T1-23 (LOW), Five api-service tenant tables ENABLE but do not FORCE RLS in-migration
- Location: `services/api/migrations/` for `tenants`, `wallet_identities`,
  `tenant_blob_purge_jobs`, `tenant_blob_purge_audit_outbox`, `email_verifications`
  (ENABLE without `FORCE ROW LEVEL SECURITY`; every other service ships a
  `*_force_rls.sql`, and newer api tables like `api_keys` /
  `production_agent_tokens` do pin FORCE).
- Low because runtime roles are non-owner (ENABLE alone enforces RLS for them) and
  the deploy reruns `infra/db-roles.sql` which FORCEs every RLS table. But a DB
  built from migrations alone, or an owner-role maintenance connection, would lack
  FORCE on these five, and `assertRuntimeDbRoles` does not assert FORCE is set.
  Fix: add an `api/migrations/*_force_rls.sql` matching the other services.

_RLS positives verified (no finding): across all service migrations (208 CREATE
POLICY statements) every policy references `app.tenant_id` (via tenant_id /
owner_id / brain_tenant_id); no `USING (true)` / `WITH CHECK (true)`; INSERT and
UPDATE write paths carry WITH CHECK, so no cross-tenant write hole. The tenant GUC
is set transaction-local (`set_config(..., true)` inside a BEGIN/COMMIT in
`withTenantScope`), so a pooled connection cannot leak a prior tenant's GUC. The
global forensic tables (`audit_integrity_findings`, `audit_verifier_checkpoint`)
are intentionally RLS-exempt but locked down by REVOKE + append-only grants, and
the production boot fence `assertRuntimeDbRoles` proves per-pool role identity,
BYPASSRLS posture, and a forbidden-privilege matrix. The T1-20 defect is a
false-clean (over-restrictive), not a leak._

_Positives verified (no finding): execution is a genuine single choke point,
`rail.dispatch()` reachable only from the outbox worker after the gate; every
money-path route derives tenantId server-side from the authenticated principal
(no route scopes off a body/query tenant, verified across API, MCP, surface
gateway, agent-router); gate check 1 re-checks `agent.state === "active"` at every
execute; the reputation module is tighten-only; and the boot-time DB-role
verification harness (`runtime-db-roles.ts`) fails closed in production. The
surface gateway's `execution.enqueue` port is a no-op stub, so surfaces cannot
reach a rail at all._

_Cross-reference to T0-11: propose-only is policy-conditional for FIAT rails too.
The Group B hard-approval floor covers only `onchain_transfer`, `escrow_release`,
and non-autonomous `x402_settle`; a policy `allow` on ach/wire/card still reaches
`outbox.enqueue` with zero approval signatures (`gate.ts` requiresHardHumanApproval
Floor returns false for fiat). This is the same design-intent question as T0-11,
now confirmed to extend to fiat auto-execution, not a separate defect._

