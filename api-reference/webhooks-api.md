# Webhooks API

Inspect and replay failed deliveries on Brain's outbound webhook endpoints. This is the operator-facing surface for dead-lettered events — the inbound provider webhook (`POST /v1/raw/webhooks/{provider}`) lives in [Sources & Raw Ingestion](sources-api.md).

| Operation                 | Endpoint                                       |
| ------------------------- | ---------------------------------------------- |
| List dead-letter events   | `GET  /v1/webhooks/{endpoint_id}/dead-letters` |
| Replay dead-letter events | `POST /v1/webhooks/{endpoint_id}/replay`       |

Both routes are tenant-isolated. The `endpoint_id` belongs to the calling tenant; a cross-tenant id returns `404`.

### How Dead-Lettering Works

Brain dispatches webhook deliveries asynchronously. Each row in the dead-letter table tracks an `attempt_count`; the delivery worker retries with exponential backoff up to **5 attempts**, after which the row is marked exhausted and stops auto-retrying. Replay (below) is the manual escape hatch.

### List Dead-Letter Events

```http
GET /v1/webhooks/{endpoint_id}/dead-letters
Authorization: Bearer <token>
```

```json
{
  "endpoint_id": "wh_ops_alerts",
  "dead_letters": [
    {
      "id": "dl_001",
      "event_id": "audit_evt_xyz",
      "event_type": "payment_intent.executed",
      "last_error": "503 Service Unavailable",
      "attempt_count": 5,
      "created_at": "2026-05-27T08:15:00Z",
      "last_attempt_at": "2026-05-27T08:47:12Z"
    }
  ]
}
```

### Replay Dead-Letter Events

Re-attempts delivery for every dead-letter row that is still under the attempt cap. Successes clear the row; failures bump `attempt_count`. The operation is **idempotent** — it accepts an `Idempotency-Key` header and is safe to retry.

```http
POST /v1/webhooks/{endpoint_id}/replay
Authorization: Bearer <token>
Idempotency-Key: <stable-key>
```

```json
{
  "endpoint_id": "wh_ops_alerts",
  "attempted": 7,
  "redelivered": 5,
  "still_failing": 2
}
```

If `still_failing > 0`, those rows had their `attempt_count` bumped; once a row hits 5 attempts it stops being auto-replayed and you can only retry it via this manual route after fixing the receiver.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📜 Audit API</strong></td><td>The events that drive outbound webhooks.</td><td><a href="audit-api.md">audit-api.md</a></td><td></td></tr><tr><td><strong>📥 Sources & Raw Ingestion</strong></td><td>The inbound webhook side (provider HMAC).</td><td><a href="sources-api.md">sources-api.md</a></td><td></td></tr></tbody></table>
