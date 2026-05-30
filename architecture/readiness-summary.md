# Readiness summary

One page. What's production-ready, what's pilot-ready, what's testnet-only, and what's blocked on external work. The deeper diligence index is at [Enterprise Readiness](enterprise-readiness.md); this page distils it for fast reads.

{% hint style="info" %}
**Current positioning.** Brain Core is a credible **staging / controlled-pilot** autonomous finance core. It is **not** yet "unrestricted production mainnet" until the external smart-contract audit and Azure deploy chain close.
{% endhint %}

## What's production-ready today

* **Six-layer protocol** (Raw, Ledger, Wiki, Policy, Agent, Audit) with strict layer boundaries enforced by lint guards.
* **§6 deterministic pre-execution gate**. 22 checks (13 numbered + 9 hardening), no LLM judgement, no Wiki reads, no skip paths.
* **Append-only audit chain** with Merkle anchoring to Base. `/v1/audit/verify` is unauthenticated. Verifiable without trusting Brain.
* **External-agent MCP surface** (JSON-RPC 2.0) with HMAC handshake and per-tenant rate limits.
* **Postgres RLS + privileged-role separation** at the storage layer; cross-tenant access is impossible by construction once `infra/db-roles.sql` is applied.
* **AES-256-GCM credential encryption** at rest (Azure Key Vault in production).
* **5 fail-closed boot fences**. Misconfigured deploys CrashLoopBackoff rather than running degraded.
* **Tenant deletion** (GDPR Article 17 database scope).

## What's pilot-ready

Suitable for controlled-pilot use under SLA, not yet for unrestricted production.

* **Payment rails** on Base **Sepolia**: `bank_ach` (Plaid sandbox or production), `onchain_base`, `x402_base`, `escrow_base`. All four register at boot when env is present.
* **Internal AI agents**: reconciliation, payment, anomaly. Run under inbound HMAC + the §6 gate on every proposal.
* **Investor-grade demo**: `pnpm run demo:golden-path` with `BRAIN_DEMO_STRICT_PROOF=true` proves the full chain end-to-end (propose → gate → execute → anchor → verify) in one command.
* **Operator readiness tools**: `pnpm run production-readiness` aggregates per-rail + per-fence + per-guard status into a single go/no-go readout.

## What's testnet-only

* **`BrainEscrow`** (USDC custodial escrow, RFC 0001 §7.6). Deployed on Base Sepolia; mainnet deploy is boot-fenced pending external audit.
* **`onchain_base` and `x402_base`** rails are wired against Base Sepolia by default. Mainnet promotion is per-tenant config, gated by the same boot fences.

## What requires external work (not yet done)

* **External smart-contract audit** of the six contracts (`BrainAuditAnchor`, `BrainPolicyRegistry`, `BrainSmartAccount`, `BrainMCPAgentRegistry`, `BrainEscrow`, `BrainReputationRegistry`). `contracts/AUDIT-SCOPE.md` is ready; engagement is pending.
* **Azure production deploy chain**. GitHub Actions workflows ship; the OIDC secrets are not provisioned and the chain has not been exercised against a live Azure environment.

## What requires customer deployment work

* Applying `infra/db-roles.sql` to the production Postgres instance (separates `brain_app` from `brain_privileged`).
* Configuring Azure Key Vault credentials for `BRAIN_SOURCE_CREDENTIAL_KEY` and the session key.
* Setting `BRAIN_ESCROW_AUDIT_APPROVED="true"` once the audit completes and bytecode is verified.
* Running the existing `pnpm run production-readiness` check against the customer env before promotion.

## How to verify any claim on this page

Each item maps to a code or runtime anchor in [Enterprise Readiness](enterprise-readiness.md). For runtime claims, the `brain.runtime.capabilities` log line at boot reports the per-rail + per-fence state; for static claims, the lint guards at `pnpm run lint` enforce the boundaries in CI.

## Risk register

The open risks corresponding to "what requires external work" and "pilot-ready" categorisation are tracked in the [Risk Register](../docs/risk-register.md) with current mitigation, owner, status, and exit criteria per risk.
