# Idempotency and Correlation Contract

This contract defines how Brain Core handles retries and end-to-end request
tracing for consequential client actions.

## Idempotency Keys

Consequential POST routes that can create work, move money, enqueue jobs, or
emit customer-facing side effects are either naturally idempotent or accept an
`Idempotency-Key` header.

Client rules:

- Generate one stable key per logical action.
- Reuse the same key when retrying the same request after a timeout or network
  failure.
- Do not reuse a key for a different request body.

Server rules:

- A completed replay with the same tenant, key, and body returns the original
  stored response and does not re-run the handler.
- A concurrent replay while the first request is still in flight returns
  `execution_idempotency_conflict`.
- Reusing the same key with a different request body returns
  `execution_idempotency_conflict`.
- Error responses are not stored, so callers can retry after a transient
  dependency failure.

The shared idempotency middleware enforces this behavior for routes marked
`idempotent: true`. Job routes such as extraction, tenant export, and source
sync also use route or repository-level dedupe so retries do not stack
duplicate work. Money-path side effects carry their own downstream idempotency
keys at the rail or outbox boundary.

## Correlation IDs

Every request has a correlation id. Clients may provide it with
`X-Request-Id`; otherwise Brain mints one. The response echoes the value in
`X-Request-Id`.

Request-path audit emits are wrapped by `CorrelatingAuditEmitter`, which copies
the current correlation id onto `audit_events.correlation_id`. Outbound webhook
payloads include the same value as `correlation_id`, so an integrator can trace
one logical action across the HTTP request, audit trail, and webhook delivery.

Background workers may omit `correlation_id` when no inbound request caused the
work. Worker-owned idempotency keys remain mandatory where the worker can retry
an external side effect.
