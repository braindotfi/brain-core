# Authorization Probes

Authorization probes let an authenticated client verify a scope grant without
loading or mutating domain data.

### Probe Payment Intent Approval Scope

```http
GET /v1/authz/probes/payment-intent-approve
Authorization: Bearer <access-token>
```

The response is `204 No Content` when the principal holds
`payment_intent:approve`. A principal without that scope receives
`403 auth_scope_insufficient`.

This endpoint has no resource identifier and makes no database, policy, audit,
outbox, or rail call. It confirms the scope only. Actual approval still applies
all member and payment authorization gates.
