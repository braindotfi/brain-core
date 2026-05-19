# Brain — Public Launch Readiness & Next Steps

**Audience**: CTO
**Author**: engineering
**Date**: 2026-05-19
**Status**: draft for review

## 1. TL;DR

Brain is technically close to a credible public launch. The SDK that the
docs commit to now exists in code (8 PRs queued, 95 tests, full coverage
of the documented surface). The HTTP API, contracts, and infra all
shipped through v0.3. The remaining work is **operational** more than
**implementation** — publish workflow, drift gates, security triage,
SLO commitments, and a staged invite-only → open-beta → GA rollout.

**Two realistic paths:**

| Path | Timeline | Audience exposed | Risk profile |
|------|----------|------------------|--------------|
| **A. Closed beta now → open beta in 4 wks → GA in 8 wks** | 8 weeks | 5–10 design partners → ~100 → public | Low; we control blast radius at each gate |
| **B. Public beta in 2 wks → GA in 4 wks** | 4 weeks | Public from week 2 | High; we ship before we've stress-tested |

**Recommendation: Path A.** This is a financial-action protocol with
on-chain anchoring; "move fast and break things" is a category mistake.
The 4-week shortcut buys little marketing momentum and costs us the
incident headroom we'd need on day one.

## 2. What's built

### SDK — `@brain/sdk` ([clients/sdk](../clients/sdk))

Just landed across 8 PRs (see commit history `feat(sdk):` series). One
typed client over the OpenAPI spec, plus a high-level `Brain` class
mirroring every documented method on docs.brain.fi:

- `brain.ask`, `brain.pay`, `brain.approve`, `brain.reject`, `brain.proof`,
  `brain.snapshot`, `brain.trace` — flat helpers
- `brain.accounts`, `.transactions`, `.counterparties`, `.obligations`,
  `.invoices`, `.balances`, `.audit`, `.payments`, `.actions`, `.agents`,
  `.raw`, `.wiki`, `.policy`, `.cashFlow` — namespaced resources
- Idempotency keys on every mutating endpoint
- Typed errors: `BrainAPIError`, `PolicyApprovalRequiredError`,
  `PolicyRejectedError`

**98% line / 92% branch / 100% function coverage. 95 tests.**

### HTTP API — `api.brain.fi/v1`

57 endpoints declared in [Brain_API_Specification.yaml](../Brain_API_Specification.yaml).
Implementation distributed across nine service workspaces. Per
[docs/v0.3-deliverables.md](v0.3-deliverables.md), v0.3 is the
"ready-for-Series-A" milestone — but Series A readiness and public
launch readiness are different bars (see §3).

### Smart contracts — Base L2

Four contracts in [contracts/src](../contracts/src): `BrainAuditAnchor`,
`BrainPolicyRegistry`, `BrainSmartAccount`, `BrainMCPAgentRegistry`.
Audit findings addressed (recent commits). Deployment summary lives at
[docs/deployment-2026-05-11.txt](deployment-2026-05-11.txt).

### Docs — docs.brain.fi

GitBook-synced to `braindotfi/brain-core/main`. Content is cleaned up
(duplicate trees removed). Some pre-existing `/broken/pages/` placeholder
links remain (12 of them, mappable to existing pages — small PR pending).

### Infra — Azure + ACR

Per [docs/v0.3-deliverables.md](v0.3-deliverables.md): Terraform under
`infra/`, main-branch CI deploys to staging, manual promote to prod.
Rollback runbook at [docs/rollback.md](rollback.md).

## 3. Gates before public launch

Triaged by what they block.

### P0 — blocks even a closed beta

| # | Gate | Status | Effort |
|---|------|--------|--------|
| P0.1 | Merge the 8 SDK PRs and publish to a registry | not started | 1–2 days |
| P0.2 | Decide publish target: **public npm** vs **GitHub Packages private** | open decision | 1 hour |
| P0.3 | Set up SDK release pipeline (semver tags → publish workflow) | not started | 1 day |
| P0.4 | Fix monorepo lint break on `main` (Node globals, test parser) | broken in main | 0.5 days |
| P0.5 | Triage 6 Dependabot vulns (4 high, 2 moderate) GitHub flags on push | not triaged | 0.5–2 days depending on root cause |
| P0.6 | OpenAPI spec audit — we already found one duplicate `Agent:` schema; do a full pass for similar latent issues | partial (1 fix landed in SDK skeleton PR) | 0.5 day |
| P0.7 | Doc-example smoke test (`1C`): CI extracts every TypeScript block from `*.md` and type-checks against the SDK. Without this we **will** ship docs that don't match the SDK | not started | 1 day |
| P0.8 | Pick 5–10 design partners, get them signed under NDA | not started | depends on BD |

### P1 — blocks open beta

| # | Gate | Status | Effort |
|---|------|--------|--------|
| P1.1 | Production / sandbox environment split documented and enforced | partially shipped (spec lists both) | 1 day |
| P1.2 | Rate limiting policy documented and enforced (spec already declares 429s) | unknown — verify implementation | 1–2 days |
| P1.3 | Auth: SIWX flow end-to-end smoke test (issued under v0.3 PR4) | shipped | smoke-test only |
| P1.4 | SLO commitment: target p99 latency + monthly availability per surface; publish on docs.brain.fi/resources/sla | not defined | 0.5 day + product call |
| P1.5 | Status page (status.brain.fi) wired to actual production health probes | not started | 1 day |
| P1.6 | Pre-execution gate (§6 13-step) stress-tested under concurrency: no double-spends under load | shipped per v0.3; needs load test | 1–2 days |
| P1.7 | Tenant isolation evidence: RLS verified end-to-end across all nine services | shipped per recent commits; needs cross-tenant pen-test | 1 day |
| P1.8 | Audit-anchor on-chain verification: end-to-end test from `audit.verify` → `BrainAuditAnchor.verify` on Base | shipped per stage-9; smoke-test before launch | 0.5 day |
| P1.9 | Terms of Service + Privacy Policy + Disclaimer reviewed by counsel for API consumers (not just web users) | docs exist; legal review status unknown | external |
| P1.10 | DPA template for enterprise prospects | not started | external |
| P1.11 | Pricing + billing: per-call meter, plan tiers, free quota for sandbox | open product decision | depends on product |
| P1.12 | API key issuance flow: self-serve registration, key rotation, scoping | unknown | 2–4 days |

### P2 — blocks GA (general availability)

| # | Gate | Status | Effort |
|---|------|--------|--------|
| P2.1 | External security audit (penetration test by reputable firm) — table stakes for FI customers | not started | 2–4 weeks (external) |
| P2.2 | SOC 2 Type I in motion (Vanta/Drata/etc.) | unknown | 4–6 weeks |
| P2.3 | On-call rotation defined, paging configured, runbooks current | partially (rollback.md exists) | 1 week |
| P2.4 | Incident response drill (game day): simulate Postgres failover, rail outage, anchor publisher down | not started | 1 day exercise + prep |
| P2.5 | Customer SLAs in contracts: 99.9% / 99.95% by tier | not defined | product + legal |
| P2.6 | 100-concurrent-agent load test on `/payment-intents/*` and pre-execution gate | not started | 2–3 days |
| P2.7 | Marketing-ready launch site, blog post, design partner case studies | external | 1–2 weeks |
| P2.8 | Support tier defined: docs + email + Slack + paid | not defined | product |
| P2.9 | Multi-region failover validated (or explicitly single-region for v1.0) | unknown — review infra | 1 week if needed |

## 4. Recommended launch sequence

### Week 1–3: closed invite-only beta

- Merge SDK PRs, publish to chosen registry.
- Close all P0 gates.
- Hand-pick 5–10 design partners. Brain Slack/Telegram support channel.
- White-glove integration: an engineer pair-programs with each partner.
- Measure: what breaks, what's confusing, what's slow, what's missing.
- **Hard stop on advertising the URL.** Single-page "we're in private
  beta" gate on the sign-up flow.

### Week 4–6: open beta (waitlist)

- Close P1 gates.
- Self-serve API key issuance with rate-limited free tier for sandbox.
- Public docs.brain.fi, public OpenAPI spec, public SDK on npm.
- Waitlist gate on production keys; sandbox keys are self-serve.
- Status page live; SLO targets publicly committed.
- First public blog post: "Brain is open for early access."

### Week 7–8+: GA

- Close P2 gates.
- Remove waitlist; production keys self-serve.
- Pricing live; billing live.
- Enterprise tier with SLA and DPA.
- Public security report (or summary) from the pen-test.
- Marketing launch sequence.

## 5. Concrete backlog (next 4 weeks)

The list is long but most items are 0.5–2 days. The critical path is
P0 → P1.1–P1.5 → P1.11–P1.12.

| Owner | Item | Estimate | Gate |
|-------|------|----------|------|
| eng | Merge `claude/jovial-hellman-64d048` (1A SDK skeleton) | 0.5 day | P0.1 |
| eng | Rebase + merge 1B.1 → 1B.7 SDK slices in order | 2 days | P0.1 |
| eng | Decide + configure publish target (npm public vs GH Packages) | 0.5 day | P0.2 |
| eng | Add GitHub Actions release workflow (tag push → publish) | 1 day | P0.3 |
| eng | Fix `eslint.config.mjs` Node globals + add `tsconfig.lint.json` per package | 0.5 day | P0.4 |
| eng | Triage 6 Dependabot vulns; upgrade or document risk | 0.5–2 days | P0.5 |
| eng | Full OpenAPI spec audit (validate, find latent dups, snake/camel) | 0.5 day | P0.6 |
| eng | 1C doc-example smoke test in CI | 1 day | P0.7 |
| BD/CEO | Identify + sign 5–10 design partners | 1 week | P0.8 |
| eng | Sandbox + prod env separation documented and rate-limited | 1–2 days | P1.1, P1.2 |
| eng | SIWX end-to-end smoke test (re-verify v0.3 PR4) | 0.5 day | P1.3 |
| product | Define SLO targets per surface + publish | 0.5 day | P1.4 |
| eng | Status page (Statuspage / Atlassian / built-in) wired to prod probes | 1 day | P1.5 |
| eng | Pre-exec gate concurrency load test | 1–2 days | P1.6 |
| eng | Cross-tenant pen-test (internal) of RLS | 1 day | P1.7 |
| eng | Audit-anchor on-chain verification smoke test | 0.5 day | P1.8 |
| legal | ToS / Privacy / Disclaimer review for API users | external | P1.9 |
| legal | DPA template | external | P1.10 |
| product | Pricing model + billing flow | 1–2 weeks | P1.11 |
| eng | Self-serve API key issuance + rotation | 2–4 days | P1.12 |

## 6. Open product / strategy decisions

CTO calls needed before P1 work can land cleanly:

1. **Publish target for `@brain/sdk`** — public npm registers us as
   "open source-y" and welcomes external auditing. Private GH Packages
   gives us tighter control but adds an npmrc auth step for customers.
   **Recommendation: public npm.** The docs already commit to
   `npm install @brain/sdk`; matching that is the lowest-friction
   developer onramp. The implementation isn't a competitive moat —
   the protocol, the policy DSL, the on-chain anchoring, and the
   service surface are.

2. **Versioning policy** — SDK semver, API URL versioning (`/v1`),
   doc versioning. Pick a clear rule: e.g., URL version bumps only on
   breaking change; SDK minor versions track non-breaking additions;
   docs always reflect the latest stable.

3. **API key model** — single key per tenant (simple) or scoped keys
   per service / per environment (Stripe-style, more secure). The
   docs already show scoped MCP attestations for agents; we should
   align human-issued keys with the same shape.

4. **Pricing model** — usage-based per-call? Per-tenant flat? Free
   sandbox + paid prod? Decide before P1.11 lands so the billing
   integration knows what to count.

5. **SLA tiers** — 99.9% default, 99.95% enterprise? Refunds on
   miss? Define before contracts go to legal.

6. **`tenantId` on flat SDK helpers** — currently a no-op argument
   matching the docs signature. Decision: either (a) extend the API
   to accept cross-tenant tokens with an `X-Tenant-Id` header, or
   (b) drop the argument from the SDK and update the docs to match.
   Lean (a) — multi-tenant support is the natural ask from
   enterprise prospects.

7. **PaymentIntent ↔ AuditEvent linkage** — the SDK's `brain.proof`
   currently requires the caller to resolve the event id via
   `brain.audit.history`. The intent shape doesn't carry an
   `audit_event_id`. Either add the field on the server side, or
   document the two-step lookup as the canonical flow. Affects every
   integration that wants to grab a proof.

8. **Multipart raw upload** — the SDK only wraps URL-based
   `/raw/ingest` today. Binary upload via multipart is the more
   common path for receipts/invoices/statements. Should land before
   open beta.

9. **Doc-driven workflow ownership** — we decided GitBook is source
   of truth. Who has editor access? Who reviews doc-driven SDK
   changes? Recommended: docs PR triggers `1C` smoke test → if it
   fails, the SDK PR that makes it pass is the canonical follow-up.

## 7. Risks I'd specifically call out

- **The pre-execution gate is the most load-bearing piece of the
  whole protocol.** If it has a concurrency bug — double-execute, race
  on idempotency key, RLS bypass under load — that's a money-loss
  incident on day one. P1.6 (concurrent load test) is non-negotiable
  before open beta.

- **The OpenAPI spec is the contract.** We already found one duplicate
  `Agent:` schema that crashed strict YAML parsers. There may be
  others. The 1C smoke test catches divergence between docs and SDK,
  but it does not catch divergence between SDK and **running server**.
  Recommend a separate CI job that runs the SDK's typed client against
  a recorded server response set — or, better, an integration test
  service that proxies real responses through.

- **The SDK is brand new.** 95 tests is high coverage for the code we
  wrote but zero real-world miles. The first design partners *will*
  find bugs we can't predict. Closed beta is for catching these
  before they hit production load.

- **`@brain/sdk` not yet on npm.** Every code example on
  docs.brain.fi currently `npm install`s a non-existent package. This
  is the loudest, most public misalignment between docs and reality.
  Fix in week 1.

- **Dependabot is flagging 6 vulns.** Could be transitive deps,
  could be a real surface. Triage cost is low; risk of ignoring is
  high. Don't ship public docs that direct people at our install
  command while CVEs are pending.

- **No publish workflow means no migration story.** The day after
  launch, someone will report a bug. We need a release workflow
  ready to ship 0.1.1 within hours, not days.

- **Status page is more important than developers think.** When a
  rail goes down, customers won't open a support ticket — they'll
  assume our API is broken. A clear status page deflects 80% of
  support volume during incidents and tells the market we're
  operationally serious.

---

**Net recommendation: 4 weeks of focused work gets us to credible
open beta. 8 weeks gets us to GA we can defend. The risk-adjusted
choice is the staged path; the temptation to skip closed beta is the
single biggest threat to a clean launch.**
