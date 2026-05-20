# Brain Test Suites

Per §7.1 of Engineering Standards, tests live in three tiers.

## Unit (`unit/`)

Co-located with source in each workspace (`services/*/src/**/*.test.ts`,
`services/agents/brain_agents/**/test_*.py`). This directory holds only the
cross-workspace unit tests that don't belong to any single service.

- TS: Vitest, 80% line coverage gate
- Python: pytest, 80% coverage gate

## Integration (`integration/`)

Cross-service. Spin up Postgres + Redis + LocalStack via `scripts/dev-up.sh`,
run the service under test as a real process, exercise endpoints end-to-end.

Every endpoint in `Brain_API_Specification.yaml` must have at least one
happy-path and one error-path integration test.

## E2E (`e2e/`)

Full stack against the staging environment. Three suites land in stage-9 ,
these are the Series A proof points (§6 of `Brain_MVP_Architecture.md`):

1. Five-layer end-to-end
2. Wiki compounding
3. External agent via MCP
