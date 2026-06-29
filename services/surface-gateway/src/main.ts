import { BotFrameworkAdapter } from "botbuilder";
import {
  BotFrameworkTeamsActivityVerifier,
  HttpEmailClient,
  SlackWebApiClient,
  TeamsBotFrameworkClient,
  type SurfaceConfig,
} from "@brain/surfaces";
import {
  buildCredentialKeyProvider,
  createLogger,
  createPool,
  loadConfig,
  PostgresAuditEmitter,
} from "@brain/shared";
import { buildSurfaceRuntime } from "@brain/core";
import type { SurfaceClients } from "@brain/core";
import { buildSurfaceGatewayApp } from "./server.js";
import { buildSurfaceGatewayServices } from "./services.js";
import {
  PostgresSlackInstallationStore,
  PostgresSlackRetryStore,
  PostgresTeamsConversationReferenceStore,
  SlackInstallationTokenProvider,
} from "./storage.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger({
    service: cfg.SERVICE_NAME,
    level: cfg.LOG_LEVEL,
    pretty: cfg.LOG_PRETTY,
  });
  const surfaceConfig = buildSurfaceConfig(cfg);

  const surfacePool = createPool({
    connectionString: cfg.BRAIN_SURFACE_GATEWAY_DB_URL ?? cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    statementTimeoutMs: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: "brain-surface-gateway",
  });
  const auditPool = createPool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    statementTimeoutMs: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: "brain-surface-gateway-audit",
  });
  const resolverPool = createPool({
    connectionString: cfg.BRAIN_RESOLVER_DB_URL ?? cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    statementTimeoutMs: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: "brain-surface-gateway-resolver",
  });

  const audit = new PostgresAuditEmitter(auditPool);
  const credentialKeyProvider = buildCredentialKeyProvider({
    kmsVaultUrl: cfg.BRAIN_AZURE_KEY_VAULT_URL,
    kmsSecretName: cfg.BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME,
    envVarKey: cfg.BRAIN_SOURCE_CREDENTIAL_KEY,
    envKeyId: cfg.BRAIN_SOURCE_CREDENTIAL_KEY_ID,
    nodeEnv: cfg.NODE_ENV,
  });
  const sourceCredential = await credentialKeyProvider.load();
  const { services, proposals } = buildSurfaceGatewayServices({
    pool: surfacePool,
    auditPool,
    resolverPool,
    audit,
  });
  const slackInstallations = new PostgresSlackInstallationStore(surfacePool, sourceCredential);
  const teamsReferences = new PostgresTeamsConversationReferenceStore(surfacePool);
  const teamsAdapter = surfaceConfig.teams.enabled
    ? new BotFrameworkAdapter({
        appId: surfaceConfig.teams.appId,
        appPassword: surfaceConfig.teams.appPassword,
      })
    : null;
  const clients: SurfaceClients = {
    ...(surfaceConfig.slack.enabled
      ? {
          slack: new SlackWebApiClient(
            new SlackInstallationTokenProvider(
              slackInstallations,
              cfg.NODE_ENV === "production" ? undefined : surfaceConfig.slack.botToken,
            ),
          ),
        }
      : {}),
    ...(surfaceConfig.email.enabled
      ? {
          email: new HttpEmailClient({
            endpoint: required(cfg.EMAIL_ENDPOINT, "EMAIL_ENDPOINT"),
            apiKey: required(cfg.EMAIL_API_KEY, "EMAIL_API_KEY"),
            ...(cfg.EMAIL_FROM !== undefined ? { from: cfg.EMAIL_FROM } : {}),
          }),
        }
      : {}),
    ...(surfaceConfig.teams.enabled && teamsAdapter !== null
      ? {
          teams: new TeamsBotFrameworkClient(
            teamsAdapter,
            surfaceConfig.teams.appId,
            teamsReferences,
          ),
        }
      : {}),
  };
  const runtime = buildSurfaceRuntime({ services, config: surfaceConfig, clients });
  const app = await buildSurfaceGatewayApp({
    runtime,
    surfaceConfig,
    proposals,
    slackRetries: new PostgresSlackRetryStore(surfacePool),
    ...(surfaceConfig.slack.enabled ? { slackInstallations } : {}),
    approvalBaseUrl: surfaceConfig.email.approvalBaseUrl || "http://localhost:3000",
    ...(teamsAdapter !== null
      ? {
          teamsVerifier: new BotFrameworkTeamsActivityVerifier(teamsAdapter, teamsReferences),
        }
      : {}),
    smoke: {
      enabled: cfg.BRAIN_SURFACE_SMOKE_ENABLED,
      ...(cfg.BRAIN_SURFACE_SMOKE_SECRET !== undefined
        ? { secret: cfg.BRAIN_SURFACE_SMOKE_SECRET }
        : {}),
    },
    logger,
  });

  const close = async (): Promise<void> => {
    await app.close();
    await Promise.all([surfacePool.end(), auditPool.end(), resolverPool.end()]);
  };
  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  await app.listen({ host: "0.0.0.0", port: cfg.PORT });
}

function buildSurfaceConfig(cfg: ReturnType<typeof loadConfig>): SurfaceConfig {
  return {
    slack: {
      enabled: cfg.SLACK_ENABLED,
      signingSecret: requiredIf(
        cfg.SLACK_SIGNING_SECRET,
        "SLACK_SIGNING_SECRET",
        cfg.SLACK_ENABLED,
      ),
      ...(cfg.SLACK_BOT_TOKEN !== undefined ? { botToken: cfg.SLACK_BOT_TOKEN } : {}),
      ...(cfg.SLACK_CLIENT_ID !== undefined ? { clientId: cfg.SLACK_CLIENT_ID } : {}),
      ...(cfg.SLACK_CLIENT_SECRET !== undefined ? { clientSecret: cfg.SLACK_CLIENT_SECRET } : {}),
      ...(cfg.SLACK_INSTALL_ADMIN_SECRET !== undefined
        ? { installAdminSecret: cfg.SLACK_INSTALL_ADMIN_SECRET }
        : {}),
    },
    teams: {
      enabled: cfg.TEAMS_ENABLED,
      appId: requiredIf(cfg.TEAMS_APP_ID, "TEAMS_APP_ID", cfg.TEAMS_ENABLED),
      appPassword: requiredIf(cfg.TEAMS_APP_PASSWORD, "TEAMS_APP_PASSWORD", cfg.TEAMS_ENABLED),
    },
    email: {
      enabled: cfg.EMAIL_ENABLED,
      approvalBaseUrl: requiredIf(
        cfg.EMAIL_APPROVAL_BASE_URL,
        "EMAIL_APPROVAL_BASE_URL",
        cfg.EMAIL_ENABLED,
      ),
      tokenSecret: requiredIf(cfg.EMAIL_TOKEN_SECRET, "EMAIL_TOKEN_SECRET", cfg.EMAIL_ENABLED),
    },
  };
}

function requiredIf(value: string | undefined, name: string, enabled: boolean): string {
  if (enabled) return required(value, name);
  return value ?? "";
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0)
    throw new Error(`Missing required env var ${name}`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
