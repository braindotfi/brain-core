# Provider Adapter Setup

Brain can run in stub-only mode with no provider credentials. Tenants opt into real providers through `/v1/tenant/integrations/{adapter_kind}`. If a tenant enables a provider whose required env vars are missing, the API rejects the configuration with `integration_provider_not_configured`.

## Tenant Integration API

Use `GET /v1/tenant/integrations` to list configured adapters. Use `PUT /v1/tenant/integrations/{adapter_kind}` with `provider`, `config`, and `enabled`. The `config` JSON is stored for provider-specific tenant settings and is returned only as `config_keys`.

Adapter kinds are `ofac`, `pep`, `kyc`, `card_issuer`, `dispute`, `reversal`, `directory`, `saas_vendor`, `llm`, `notification`, and `blob`.

## AML and PEP

Primary provider: ComplyAdvantage.

Required env:

- `COMPLY_ADVANTAGE_API_KEY`
- `COMPLY_ADVANTAGE_ENDPOINT`

Fallback provider: OpenSanctions. It is lower quality and should be used only for sandbox or degraded mode.

Setup:

1. Create a ComplyAdvantage API key with search permission.
2. Set the endpoint for the tenant region.
3. Enable `ofac` or `pep` with provider `comply_advantage`.

## KYC

Primary provider: Sumsub.

Required env:

- `SUMSUB_APP_TOKEN`
- `SUMSUB_SECRET`

Setup:

1. Create a Sumsub app token.
2. Configure webhook and API read permissions for applicant packets.
3. Enable `kyc` with provider `sumsub`.

On refresh, the adapter reads the latest applicant packet, computes a packet hash, and marks expiry one year after the latest provider update.

## Card Issuing

Primary provider: Stripe Issuing.

Required env:

- `STRIPE_ISSUING_API_KEY`

Setup:

1. Create a restricted Stripe key with Issuing card management access.
2. Enable `card_issuer` with provider `stripe_issuing`.

NymCard remains a later UAE-specific provider.

## Disputes

Primary provider: Chargeflow.

Required env:

- `CHARGEFLOW_API_KEY`

Setup:

1. Create a Chargeflow API key.
2. Enable `dispute` with provider `chargeflow`.

If there is no vendor contract, leave the integration disabled. Manual dispute filing through support remains the fallback.

## Payment Reversal

Card reversals use Stripe refunds through `STRIPE_ISSUING_API_KEY`. ACH returns use First Meridian.

Required ACH env:

- `FIRST_MERIDIAN_API_KEY`
- `FIRST_MERIDIAN_ENDPOINT`

Wire reversals are not automated and return a manual-required reference.

## Directory Providers

Google Workspace env:

- `GOOGLE_DIRECTORY_SERVICE_ACCOUNT_KEY`

Microsoft Entra env:

- `ENTRA_CLIENT_ID`
- `ENTRA_CLIENT_SECRET`
- `ENTRA_TENANT_ID`

Okta env:

- `OKTA_API_TOKEN`
- `OKTA_DOMAIN`

Enable `directory` with provider `google_workspace`, `microsoft_entra`, or `okta` once the tenant grants the matching directory API access.

## SaaS Vendor APIs

Implemented providers:

- `adobe_admin`
- `slack_admin`
- `microsoft_365_admin`
- `notion_admin`

If a vendor API cannot perform the downgrade, the adapter falls back to drafting an email through NotificationService.

## Robo LLM

Provider: Anthropic Claude.

Required env:

- `ANTHROPIC_API_KEY`

Model policy:

- `claude-opus-4-5` for complex asks and briefs
- `claude-sonnet-4` for simple asks

The Robo adapter logs token usage to audit events when audit context is supplied.

## Notifications

Email provider: Postmark.

Required env:

- `POSTMARK_API_KEY`
- `POSTMARK_FROM_EMAIL`

SMS provider: Twilio.

Required env:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

Slack webhooks are tenant config, not process env.

## Blob Store

Provider: S3.

Required env:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_S3_BUCKET`
- `AWS_REGION`

Retention:

- `standard`: lifecycle move to S3 Intelligent Tiering after 90 days
- `compliance_7yr`: lifecycle move to S3 Glacier Deep Archive after 30 days
- `permanent`: stay in standard tier

Create lifecycle policies in S3 before enabling the `blob` adapter. GCS remains a TODO provider.

## Live Provider Tests

Live provider tests must be skipped unless `RUN_LIVE_PROVIDER_TESTS=1` is set. Use sandbox accounts and test credentials for every provider. CI should run interface conformance tests against stubs and provider classes without making network calls.

## Test Credentials

Do not commit live provider secrets. Store sandbox credentials in the deployment secret manager and mirror only variable names in `.env.example`. For local smoke tests, use provider sandbox accounts with non-production tenants and set `RUN_LIVE_PROVIDER_TESTS=1` only for the command that needs network access.

Known gotchas:

- ComplyAdvantage endpoints are region-specific.
- Sumsub signatures include timestamp, method, path, and body in that exact order.
- Stripe Issuing keys must include issuing card write permissions.
- Microsoft Graph requires admin consent for directory reads.
- S3 lifecycle rules are bucket configuration, not application code.
