# Robo Service

Robo is the assistant surface for RobotMoney. It keeps the existing message
answering path and adds two entry points for Inbox and Assistant surfaces.

## Morning Brief

`POST /v1/robo/brief` accepts `tenant_id` and optional `as_of`. It returns one
cached brief per tenant and date. A cache hit returns the original
`prepared_at`; a cache miss compiles the brief and stores the full response in
`brief_cache`.

`GET /v1/robo/brief/{tenant_id}?date=YYYY-MM-DD` is a strict cache read. It
returns 404 when the date has not been compiled yet.

The compiler reads:

- Latest account balances from `ledger_balances` for `cash_on_hand`.
- Posted and cleared `ledger_transactions` for `net_30_day`.
- `audit_events` with `decision.executed` for overnight execution count.
- Pending proposal read-model rows for urgent highlights.
- Pending `cash_forecast` proposal fields for runway when available.

If a source does not contain a value, Robo omits the related optional field.
It does not fabricate values. Tenant timezone is not yet first-class in the
tenant row, so omitted `as_of` uses the server current UTC date.

## Ask From Context

`POST /v1/robo/ask-from-context` accepts a proposal rail source and prompt. It
creates a new `robo_threads` row, stores the first user message, freezes the
proposal payload through `proposal_payload_snapshots`, and answers through the
existing Wiki question orchestrator.

When `open_thread` is omitted or true, the route streams `thread`, `message`,
and `done` events with `text/event-stream`. When `open_thread` is false, it
returns `{ thread_id, first_response }` as JSON.

The route emits `robo.thread.opened_from_context` for analytics with the source,
thread id, snapshot id, and answer status.

## Answer Shape

Robo answers use the additive shape:

```json
{
  "text": "Cash is stable.",
  "data_cards": [],
  "charts": [],
  "follow_ups": [],
  "refs": []
}
```

Existing free-form assistant answers remain valid because `text` carries the
prose and the structured arrays are optional. Existing thread and message APIs
are not changed.

## Storage

`brief_cache` stores one full brief response per `(tenant_id, brief_date)`.
`robo_threads` and `robo_messages` store the context-opened thread records used
by the new route. All three tables are tenant scoped with row-level security.

## Migration Note

The new response fields and schemas are additive. Existing clients that only
read the previous assistant prose are unaffected.
