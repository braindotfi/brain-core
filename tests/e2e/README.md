# Brain E2E Proof Tests

These three suites prove the three Series A claims from
`Brain_MVP_Architecture.md` §6. They run against staging
(`https://api.sandbox.brain.fi/v1` by default) on every main-branch
merge, gated before the production promotion step in
`.github/workflows/main.yml`.

## Environment

| Variable                     | Required by  | Notes                                                                                         |
| ---------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `BRAIN_BASE_URL`             | all 3 suites | Staging endpoint.                                                                             |
| `BRAIN_TOKEN`                | suites 1 + 2 | Tenant-admin JWT minted by seed script.                                                       |
| `BRAIN_TEST_TENANT_ID`       | suites 1 + 2 | `tnt_...` for the seeded test tenant.                                                         |
| `BRAIN_TEST_VENDOR_ID`       | suites 1 + 3 | `cp_...` or ULID of a seeded vendor entity.                                                   |
| `BRAIN_EXTERNAL_AGENT_TOKEN` | suite 3      | JWT for an external agent (`principal_type=agent`) pre-registered in `BrainMCPAgentRegistry`. |

When a variable is absent, the affected suite skips, local runs don't
fail CI, but staging runs that are missing any variable should.

## Suites

- `five-layer.e2e.test.ts`, end-to-end happy path (raw → wiki → policy
  → execution → audit).
- `wiki-compounding.e2e.test.ts`, monotonic increase across 12
  synthetic months in entity count, relation density, avg confidence,
  and human-confirmed count.
- `external-agent-mcp.e2e.test.ts`, external agent via MCP: ping +
  wiki:read + execution:propose, each gated by the same policy and
  logged to the same audit chain as an internal agent.
