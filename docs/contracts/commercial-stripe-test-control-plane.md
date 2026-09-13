# Commercial Stripe test control plane

Status: Phase 1, provider-disabled.

The RobotMoney merchant billing integration owns the reserved webhook namespace
`POST /v1/commercial-billing/stripe/webhooks`. It is separate from the Raw
service's tenant-owned Stripe source ingestion. Phase 1 does not register the
HTTP route or call Stripe.

The control plane accepts only `sk_test_*` credentials and Stripe objects whose
`livemode` field is false. Both request and webhook contracts are pinned to
Stripe API version `2026-02-25.clover`. Enabling the commercial Stripe gate with
missing, live-mode, or differently versioned configuration fails closed.

Free has no Stripe subscription. Starter, Growth, and Scale map to three public
Products and eighteen immutable Prices: three currencies times two intervals
for each tier. Enterprise remains operator-invoiced and has no public Price.

The catalog operator exposes `inspect`, `plan`, `apply`, and `verify`. Apply
requires `APPLY_STRIPE_TEST_CATALOG_V1`, addresses each object by its immutable
Brain revision id, and is idempotent. The provider adapter arrives in a later
reviewed phase, so this phase cannot create a Stripe object.

`commercial_stripe_webhook_inbox`, processing attempts, price bindings, and
operator receipts are append-only. The dedicated
`brain_stripe_billing_worker` capability role owns the minimum write surface.
It is `NOLOGIN` until a later phase provisions a runtime credential.

The secret names reserved for the later worker are:

- `BRAIN_COMMERCIAL_STRIPE_SECRET_KEY_TEST`
- `BRAIN_COMMERCIAL_STRIPE_WEBHOOK_SECRET_TEST`
- `BRAIN_COMMERCIAL_STRIPE_DB_URL`

No value for any of these is created or required while the gate is false.
