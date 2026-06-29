/**
 * Centralized config. Fail fast at boot if a required secret is missing rather
 * than at first message. No secret is ever hardcoded.
 */
export interface SurfaceConfig {
  slack: {
    enabled: boolean;
    signingSecret: string;
    botToken?: string | undefined;
    clientId?: string | undefined;
    clientSecret?: string | undefined;
    installAdminSecret?: string | undefined;
  };
  teams: {
    enabled: boolean;
    appId: string;
    appPassword: string;
    installAdminSecret?: string | undefined;
  };
  email: {
    enabled: boolean;
    approvalBaseUrl: string;
    tokenSecret: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SurfaceConfig {
  return {
    slack: {
      enabled: env.SLACK_ENABLED === "true",
      signingSecret: required(env, "SLACK_SIGNING_SECRET", env.SLACK_ENABLED === "true"),
      botToken: optional(env, "SLACK_BOT_TOKEN"),
      clientId: optional(env, "SLACK_CLIENT_ID"),
      clientSecret: optional(env, "SLACK_CLIENT_SECRET"),
      installAdminSecret: optional(env, "SLACK_INSTALL_ADMIN_SECRET"),
    },
    teams: {
      enabled: env.TEAMS_ENABLED === "true",
      appId: required(env, "TEAMS_APP_ID", env.TEAMS_ENABLED === "true"),
      appPassword: required(env, "TEAMS_APP_PASSWORD", env.TEAMS_ENABLED === "true"),
      installAdminSecret: optional(env, "TEAMS_INSTALL_ADMIN_SECRET"),
    },
    email: {
      enabled: env.EMAIL_ENABLED === "true",
      approvalBaseUrl: required(env, "EMAIL_APPROVAL_BASE_URL", env.EMAIL_ENABLED === "true"),
      tokenSecret: required(env, "EMAIL_TOKEN_SECRET", env.EMAIL_ENABLED === "true"),
    },
  };
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v && v.length > 0 ? v : undefined;
}

function required(env: NodeJS.ProcessEnv, key: string, mustExist: boolean): string {
  const v = env[key];
  if (mustExist && (!v || v.length === 0)) {
    throw new Error(`Missing required env var ${key}`);
  }
  return v ?? "";
}
