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
- [ ] T0-5 product decision pending
- [x] T0-6 fixed: Deploy scripts now require Base Sepolia chain id before broadcasting.
- [x] T0-8 fixed: Escrow audit and bytecode gates now require the full audit path on any non-testnet chain.
- [x] T0-9 fixed: API boot now checks explicit BASE_RPC_URL eth_chainId against BRAIN_BASE_CHAIN_ID.
- [ ] T0-10 pending
- [ ] T0-11 product decision pending
- [ ] T0-12 pending
- [ ] T0-13 confirm intent pending

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
2. T0-11 (HIGH): a policy `allow` outcome takes an on-chain payment intent to
   submission with no recorded human approval, and no hard code gate forces
   per-action approval for on-chain action types (propose-only is
   policy-conditional, not code-enforced). Needs a design-intent decision.

T0-4 (behaviorHash replay), T0-10 (x402 outside the escrow fence), T0-12
(lint-only loader containment for 5.5/8.5), and T0-8 (gate hardcodes 8453) are the
medium tier. The propose-only invariant, as literally stated in the brief, is NOT
enforced by code today; whether that is a defect or an accepted design depends on
whether a human-authored `allow` policy counts as the required approval, which is
the one question to resolve before a production on-chain launch. Overall Tier 0
readiness: NOT READY for a value-bearing on-chain mainnet launch until T0-1 and
T0-11 are resolved; the testnet posture is sound and the escrow mainnet fence
correctly holds the line in the meantime.

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
