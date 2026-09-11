# Commercial shadow API and MCP evidence contract

## Status

This contract defines RFC 0011 Phase 2 observation infrastructure. It does not
create the internal shadow tenant, start an observation period, enable billing,
or apply an entitlement decision. The guarded operator in Phase 3 owns those
actions.

## Tenant binding

Each `commercial_shadow_periods` row may be bound to exactly one tenant through
one immutable `commercial_shadow_contracts` row. The contract pins:

- tenant id and shadow period id,
- commercial catalog revision and entitlement version,
- `sandbox` or `live` environment,
- included API units,
- included MCP units, and
- contract version and authenticated operator attribution.

The API process instruments MCP calls only when
`BRAIN_COMMERCIAL_SHADOW_ENABLED=true` and
`BRAIN_COMMERCIAL_SHADOW_TENANT_ID` names the exact bound tenant. Other tenants
take no shadow-meter database path. The target tenant fails closed if its active
contract is missing.

## Unit definitions

An API unit continues to use RFC 0008's policy-versioned request meter. An MCP
unit is one successfully fulfilled `tools/call`. Rejected, malformed,
rate-limited, failed, and notification-form tool calls are observed and metered
as attempts but contribute zero MCP units.

Every commercial shadow observation stores cumulative API and MCP units plus a
separate result for each dimension:

- `within` when complete reconciled evidence is at or below the pinned
  allowance,
- `over` when complete reconciled evidence exceeds the pinned allowance, and
- `unresolved` when the applicable reconciliation or allowance is incomplete.

The observation also stores the exact API and MCP reconciliation ids,
completeness booleans, divergence codes, and source descriptions. It always
stores `enforcement_applied=false`.

## Independent MCP evidence

MCP completeness uses three distinct stores:

1. `mcp_transport_tool_observations` is written before tool dispatch at the
   authenticated HTTP transport boundary.
2. `mcp_tool_meter_events` is written after dispatch and classifies the logical
   tool outcome. It does not depend on or reference the transport table.
3. `mcp_usage_daily_rollups` is reproducibly rebuilt only from meter events.

`mcp_usage_reconciliation_runs` compares transport count, raw meter count,
fulfilled units, rollup count, rollup units, missing meter rows, unexpected meter
rows, and explicit meter-persistence failures. A missing meter row or persistence
failure is `incomplete`. Other count divergence is `mismatch`. Only agreement
across all three sources is `matched`.

Transport observations, meter events, persistence-failure evidence,
reconciliation runs, shadow contracts, and final shadow observations are
append-only or immutable at the database boundary. Tenant RLS is enabled and
forced on every tenant-owned table.

## Isolation from billing

The metering policy is `mcp_tools_v1_shadow` and always carries `charge=false`.
These observations do not create allowance reservations, billing periods,
charge facts, Stripe state, x402 state, or provider commands. The separate
immutable `commercial_billing_exclusions` contract remains the database-enforced
billing isolation boundary for the eventual internal tenant.
