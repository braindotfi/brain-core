# Commercial shadow daily operations

The RFC 0011 production shadow uses one tenant created by the guarded shadow
operator. Phase 4 does not create that tenant and does not start its 30-day
period.

## Schedule and workload

`brain-commercial-shadow-daily.timer` fires at 01:15 UTC. A weekday run sends
exactly 1,000 commercial API reads and 100 MCP read tool calls. A Saturday or
Sunday run sends exactly 500 API reads and 50 MCP read tool calls. Calls use the
tenant's real `brain_sk_live_*` key and its `brain_ak_live_*` BFF credential.
The BFF credential is exchanged at the production authorization server and the
resulting five-minute token is narrowed to `ledger:read wiki:read` before it is
sent to the MCP transport.

The workload window is fixed to UTC dates 2026-10-01 through 2026-10-31.
Scheduler firings before or after that range refresh health but send no workload
traffic and are reported as `not_expected`.

The driver uses only read routes and read tools. It reaches the same production
authentication, Redis rate-limit, gateway observation, API meter, MCP transport
observation, and MCP meter paths used by external traffic. It never calls a
payment, write, approval, execution, Stripe, x402, or rail surface.

## Durable completion

A day is complete only when all planned calls are visible in the raw transport
observations, the API and MCP reconciliations both match their independent meter
and rollup evidence, and a complete commercial shadow observation exists. The
operator then inserts one immutable `commercial_shadow_daily_runs` row. Direct
runtime inserts, updates, deletes, and truncates are forbidden.

The driver is restart-safe for a partially completed day. It counts that day's
durable transport observations for the two dedicated credentials and sends only
the remaining calls. A completed day is idempotent and sends no further traffic.

## Scheduler heartbeat

`brain-commercial-shadow-heartbeat.timer` refreshes the
`commercial_shadow_daily_v1` database heartbeat every five minutes. The writer
records the exact image SHA, ready or unhealthy state, check time, and next daily
run. The Phase 3 start gate requires this heartbeat to be ready, no more than 15
minutes old, and bound to the approved deployed SHA.

If the daily driver fails, its wrapper writes an unhealthy heartbeat and exits
nonzero. The heartbeat loop keeps that state unhealthy while the daily service
remains failed. It does not create final daily evidence.

## Reporting and missing-run alert

`commercial-shadow-daily-report.yml` runs at 04:00 UTC and retrieves the prior
UTC day's durable result. It publishes the complete sanitized result to the
workflow summary and retains a report artifact for 40 days. If the lifecycle was
running at the scheduled instant and the daily row is missing, reconciliation is
not complete, billing isolation is false, or the scheduler is unhealthy or
stale, the workflow opens one deduplicated GitHub issue and fails visibly.

Days on which the shadow was not running at 01:15 UTC are reported as
`not_expected` and do not advance completeness evidence. Pausing or stopping the
shadow cannot rewrite prior daily evidence.

## Billing isolation

Every run calls the database zero-billing assertion before final evidence can be
inserted. The immutable `commercial_billing_exclusions` row and Phase 1 database
prohibitions remain authoritative. Workload events can affect shadow counters
only. Their observation records carry `enforcement_applied=false`; they cannot
create billing accounts, Stripe state, x402 operations, provider commands,
charge facts, billable periods, or adjustments.
