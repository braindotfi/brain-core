import type { Pool } from "pg";

const REQUIRED_ENV: Readonly<Record<string, readonly string[]>> = {
  comply_advantage: ["COMPLY_ADVANTAGE_API_KEY", "COMPLY_ADVANTAGE_ENDPOINT"],
  opensanctions: [],
  sumsub: ["SUMSUB_APP_TOKEN", "SUMSUB_SECRET"],
  stripe_issuing: ["STRIPE_ISSUING_API_KEY"],
  chargeflow: ["CHARGEFLOW_API_KEY"],
  first_meridian: ["FIRST_MERIDIAN_API_KEY", "FIRST_MERIDIAN_ENDPOINT"],
  google_workspace: ["GOOGLE_DIRECTORY_SERVICE_ACCOUNT_KEY"],
  microsoft_entra: ["ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_TENANT_ID"],
  okta: ["OKTA_API_TOKEN", "OKTA_DOMAIN"],
  adobe_admin: [],
  slack_admin: [],
  microsoft_365_admin: [],
  notion_admin: [],
  anthropic: ["ANTHROPIC_API_KEY"],
  postmark: ["POSTMARK_API_KEY", "POSTMARK_FROM_EMAIL"],
  twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  s3: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_BUCKET", "AWS_REGION"],
};

interface EnabledIntegrationRow {
  tenant_id: string;
  adapter_kind: string;
  provider: string;
}

export async function assertEnabledIntegrationsConfigured(
  pool: Pool,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const { rows } = await pool.query<EnabledIntegrationRow>(
    `SELECT tenant_id, adapter_kind, provider
       FROM tenant_integrations
      WHERE enabled = TRUE`,
  );
  const failures = rows
    .map((row) => ({
      ...row,
      missing: (REQUIRED_ENV[row.provider] ?? []).filter(
        (name) => env[name] === undefined || env[name] === "",
      ),
    }))
    .filter((row) => row.missing.length > 0);
  if (failures.length === 0) return;
  const summary = failures
    .map((row) => `${row.tenant_id}:${row.adapter_kind}:${row.provider}:${row.missing.join(",")}`)
    .join("; ");
  throw new Error(`enabled tenant integrations have missing provider env: ${summary}`);
}
