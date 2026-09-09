# Authorization Probes

This contract defines authenticated, side-effect-free capability probes. A
probe answers only whether the presented principal holds a named scope. It does
not claim that a later domain operation will pass resource, membership, policy,
amount, payee, or dual-control authorization.

## Payment Intent Approval

```http
GET /v1/authz/probes/payment-intent-approve
Authorization: Bearer <access-token>
```

The route and both real approval aliases use the same exported
`requirePaymentIntentApproveScope` guard and its single
`payment_intent:approve` scope constant.

- Missing scope returns `403 auth_scope_insufficient`.
- Held scope returns `204 No Content` with an empty body.
- The route accepts no resource identifier and performs no resource lookup.
- It makes no database query, policy evaluation, domain-service call, audit
  event, outbox operation, or rail call.
- Normal access logging, request correlation, rate limiting, and security
  telemetry remain permitted.

The zero-side-effect rule is a compatibility contract, not an implementation
detail. Callers may use this route to verify a credential's approval scope
without creating proposals or audit evidence and without relying on a reserved
or nonexistent PaymentIntent identifier.
