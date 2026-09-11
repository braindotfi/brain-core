# Commercial Billing Exclusions

`commercial_billing_exclusions` is the durable safety boundary for internal
production tenants that exercise commercial shadow behavior without ever
becoming chargeable.

## Creation

Only the protected `brain_privileged` operator may create an exclusion, and it
may do so only through
`create_internal_commercial_shadow_billing_exclusion(tenant_id, actor, reason)`.
The operator has no direct insert privilege on the table.

Creation fails when the tenant already has any of the following state:

- a commercial billing-account link,
- a priced or billing-account-backed commercial entitlement,
- a Stripe subscription or tenant-attributed Stripe event,
- a commercial charge fact,
- a tenant-attributed x402 payment operation,
- a tenant-attributed commercial provider command, or
- a billable API usage period, any nonzero chargeable units, or an API billing
  adjustment.

The exclusion and billing guards take the same tenant-row lock before checking
state. This serializes concurrent exclusion and billing-link attempts so both
cannot commit around a negative-existence check.

The creation function is idempotent for a tenant that already has an exclusion.
It never changes the original actor, reason, kind, or timestamp.

## Immutability

The table uses `ON DELETE RESTRICT` against the tenant. Row and statement
triggers reject update, delete, and truncate operations, including operations
attempted by the table owner. Removing an exclusion therefore requires a later
reviewed migration that changes this contract.

The tenant foreign key uses `ON DELETE RESTRICT`, and the tenant-deletion
registry classifies the exclusion as preserved. An excluded shadow tenant
cannot be retired through ordinary tenant deletion. Retirement requires a
reviewed migration that retains the exclusion evidence while deliberately
changing this relationship.

Every application and operational runtime role lacks insert, update, delete,
truncate, references, and trigger privileges. `brain_privileged` receives
SELECT only, plus execute on the narrow creation function. Reapplying
`infra/db-roles.sql` removes stale grants and verifies the postcondition.

## Enforced prohibitions

Database triggers reject an insert or update that would connect an excluded
tenant to:

- `commercial_billing_account_tenants`,
- a priced or billing-account-backed `tenant_commercial_entitlements` row,
- `commercial_stripe_subscriptions`,
- `commercial_stripe_events`,
- `commercial_charge_facts`,
- `x402_payment_operations`,
- `commercial_provider_commands`, or
- a billable `api_billing_periods` row or `api_billing_adjustments` row.

An RFC 0008 `shadow_closed` usage period remains permitted only with
`chargeable_units=0`. Catalog-only commercial entitlements remain permitted
when both `price_revision_id` and `billing_account_id` are null.

The exclusion does not turn on a commercial feature, create a tenant, create a
credential, or start an observation window.
