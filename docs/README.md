# Brain Core Developer Docs

Audience: Brain engineers and deployment owners  
Last updated: 2026-06-22

This folder contains engineering runbooks, diligence notes, RFCs, historical
audits, and implementation-specific docs that are not part of the public
GitBook navigation. Public docs live at the repository root folders listed in
`SUMMARY.md` (`architecture/`, `protocol/`, `api-reference/`, `mcp-server/`,
`smart-contracts/`, and related folders).

## Start Here

Use these docs for the current production-readiness picture:

- `architecture/readiness-summary.md`: short public-facing readiness summary.
- `architecture/enterprise-readiness.md`: diligence-facing safety and readiness
  index with code anchors.
- `docs/diligence/dev-team-production-readiness-pack.md`: engineering packet
  for the current deployment posture, release gates, diagrams, and workstreams.
- `docs/diligence/agent-and-onchain-event-map.md`: agent, audit event, on-chain
  event, watcher, and reconciliation map.
- `docs/risk-register.md` and `docs/risk-register.json`: human-readable and
  machine-readable production risk register.
- `docs/r03-staging-deploy-runbook.md`: staging deploy and release-candidate
  evidence runbook.

## Operational Runbooks

- `docs/audit-outbox-recovery-runbook.md`
- `docs/golden-path.md`
- `docs/rollback.md`
- `docs/rails-matrix.md`
- `docs/sandbox-mode.md`
- `docs/partner-connector-isolation.md`
- `docs/external-agent-onboarding.md`

## RFCs And Design Records

- `docs/rfcs/`: active and historical RFCs.
- `docs/adr/`: architecture decision records.
- `docs/contracts/`: implementation notes for contract-adjacent surfaces.

## Historical Material

- `docs/audit/`: historical engineering audit from May 2026. These reports are
  useful for context, but individual findings may have been fixed or superseded.
  Always verify against current code, the risk register, and the readiness
  tooling before treating an audit statement as current.
- `docs/archive/`: old planning memos and launch notes retained for provenance.

## Documentation Maintenance

When readiness semantics or production posture changes, update all of:

1. `architecture/readiness-summary.md`
2. `architecture/enterprise-readiness.md`
3. `docs/diligence/dev-team-production-readiness-pack.md`
4. `docs/risk-register.md` and `docs/risk-register.json`, when risks change
5. `resources/changelog.md`

Before merging documentation changes, run:

```bash
pnpm run check-docs-drift
pnpm run check-no-em-dashes
pnpm run readiness:evidence -- --profile staging
```

`readiness:evidence -- --profile staging` exits nonzero while staging blockers
remain. For documentation-only changes, that is expected if the output matches
the current readiness summary and no new blocker appears.
