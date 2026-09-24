import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  brainError,
  requireScope,
  withTenantScope,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";

const READ: Scope = "execution:read";
const ADMIN: Scope = "execution:admin";

const ADAPTER_KINDS = new Set([
  "ofac",
  "pep",
  "kyc",
  "card_issuer",
  "dispute",
  "reversal",
  "directory",
  "saas_vendor",
  "llm",
  "notification",
  "blob",
]);

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

export interface IntegrationRoutesDeps {
  readonly pool: Pool;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: IntegrationRoutesDeps,
): Promise<void> {
  app.get("/tenant/integrations", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, READ);
    const rows = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const result = await client.query(
        `SELECT tenant_id, adapter_kind, provider, config, enabled, created_at, updated_at
           FROM tenant_integrations
          WHERE tenant_id = $1
          ORDER BY adapter_kind`,
        [ctx.tenantId],
      );
      return result.rows.map((row) => maskIntegration(row, deps.env ?? process.env));
    });
    reply.status(200);
    return { integrations: rows };
  });

  app.put(
    "/tenant/integrations/:adapter_kind",
    async (
      request: FastifyRequest<{
        Params: { adapter_kind: string };
        Body: { provider?: string; config?: Record<string, unknown>; enabled?: boolean };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, ADMIN);
      const adapterKind = request.params.adapter_kind;
      if (!ADAPTER_KINDS.has(adapterKind)) {
        throw brainError("request_params_invalid", "unknown adapter_kind");
      }
      const provider = nonEmpty(request.body?.provider, "provider");
      const enabled = request.body?.enabled === true;
      if (enabled) {
        const missing = missingEnv(provider, deps.env ?? process.env);
        if (missing.length > 0) {
          throw brainError("integration_provider_not_configured", "provider env is missing", {
            statusOverride: 409,
            details: { provider, missing_env: missing },
          });
        }
      }
      const config = request.body?.config ?? {};
      const row = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const result = await client.query(
          `INSERT INTO tenant_integrations (
             tenant_id, adapter_kind, provider, config, enabled
           )
           VALUES ($1,$2,$3,$4::jsonb,$5)
           ON CONFLICT (tenant_id, adapter_kind) DO UPDATE SET
             provider = EXCLUDED.provider,
             config = EXCLUDED.config,
             enabled = EXCLUDED.enabled,
             updated_at = now()
           RETURNING tenant_id, adapter_kind, provider, config, enabled, created_at, updated_at`,
          [ctx.tenantId, adapterKind, provider, JSON.stringify(config), enabled],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw brainError("internal_server_error", "integration upsert did not return a row");
        }
        return row;
      });
      reply.status(200);
      return maskIntegration(row, deps.env ?? process.env);
    },
  );
}

function assertCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
    principalType: request.principal.type,
    scopes: request.principal.scopes,
  };
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw brainError("request_body_invalid", `${name} is required`);
  }
  return value.trim();
}

function missingEnv(
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return (REQUIRED_ENV[provider] ?? []).filter(
    (name) => env[name] === undefined || env[name] === "",
  );
}

function maskIntegration(
  row: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const missing = missingEnv(String(row.provider), env);
  return {
    tenant_id: row.tenant_id,
    adapter_kind: row.adapter_kind,
    provider: row.provider,
    enabled: row.enabled,
    requires_setup: missing.length > 0,
    missing_env: missing,
    config_keys: Object.keys((row.config ?? {}) as Record<string, unknown>),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
