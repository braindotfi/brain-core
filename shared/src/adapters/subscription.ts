import type { NotificationService } from "./decision-execution.js";
import {
  bearerHeaders,
  fetchJson,
  providerSetup,
  withProviderFallback,
  type ProviderAdapterOptions,
  type ProviderSetupState,
} from "./provider-support.js";

export type DirectoryProviderKind = "none" | "okta" | "google_workspace" | "microsoft_entra";

export interface DirectoryActiveUser {
  readonly name: string;
  readonly email: string;
  readonly last_active: string;
  readonly apps_used: readonly string[];
}

export interface DirectorySubscriptionUsage {
  readonly subscription_id: string;
  readonly merchant?: string;
  readonly licensed: number;
  readonly active_30d: number;
  readonly active_users: readonly DirectoryActiveUser[];
}

export interface DirectoryProvider {
  readonly kind: DirectoryProviderKind;
  listSubscriptionUsage(
    tenantId: string,
    now: Date,
  ): Promise<readonly DirectorySubscriptionUsage[]>;
}

export interface SaaSVendorApiResult {
  readonly status: "submitted" | "unsupported";
  readonly note?: string;
}

export interface SaaSVendorApi {
  requestSeatDowngrade(input: {
    readonly tenant_id: string;
    readonly subscription_id: string;
    readonly seats: number;
  }): Promise<SaaSVendorApiResult>;
}

export class NoneDirectoryProvider implements DirectoryProvider {
  readonly kind = "none" as const;

  async listSubscriptionUsage(
    _tenantId: string,
    _now: Date,
  ): Promise<readonly DirectorySubscriptionUsage[]> {
    return [];
  }
}

export class TodoDirectoryProvider implements DirectoryProvider {
  constructor(readonly kind: Exclude<DirectoryProviderKind, "none">) {}

  async listSubscriptionUsage(
    _tenantId: string,
    _now: Date,
  ): Promise<readonly DirectorySubscriptionUsage[]> {
    // TODO(subscription_management): emit subscription.new_signup_detected
    // from concrete SSO adapters once connector feed rows exist.
    return [];
  }
}

export class StubSaaSVendorApi implements SaaSVendorApi {
  async requestSeatDowngrade(_input: {
    readonly tenant_id: string;
    readonly subscription_id: string;
    readonly seats: number;
  }): Promise<SaaSVendorApiResult> {
    return { status: "unsupported", note: "vendor_api_not_wired" };
  }
}

export interface GoogleWorkspaceDirectoryProviderOptions extends ProviderAdapterOptions {
  readonly serviceAccountKey: string;
  readonly subject?: string;
}

export class GoogleWorkspaceDirectoryProvider implements DirectoryProvider {
  public readonly kind = "google_workspace" as const;

  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    return providerSetup("google_workspace", env, ["GOOGLE_DIRECTORY_SERVICE_ACCOUNT_KEY"]);
  }

  private readonly fetchImpl: typeof fetch;
  private readonly fallback = new NoneDirectoryProvider();

  public constructor(private readonly opts: GoogleWorkspaceDirectoryProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public listSubscriptionUsage(
    tenantId: string,
    now: Date,
  ): Promise<readonly DirectorySubscriptionUsage[]> {
    return withProviderFallback(
      {
        adapterKind: "directory",
        provider: "google_workspace",
        operation: "listSubscriptionUsage",
        tenantId,
      },
      this.opts,
      async () => {
        const token = JSON.parse(this.opts.serviceAccountKey) as { access_token?: string };
        const raw = await fetchJson(
          this.fetchImpl,
          "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=500",
          {
            method: "GET",
            headers: bearerHeaders(token.access_token ?? this.opts.serviceAccountKey),
          },
        );
        return [usageFromDirectoryRows("google_workspace", raw, now)];
      },
      () => this.fallback.listSubscriptionUsage(tenantId, now),
    );
  }
}

export interface EntraDirectoryProviderOptions extends ProviderAdapterOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tenantId: string;
}

export class EntraDirectoryProvider implements DirectoryProvider {
  public readonly kind = "microsoft_entra" as const;

  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    return providerSetup("microsoft_entra", env, [
      "ENTRA_CLIENT_ID",
      "ENTRA_CLIENT_SECRET",
      "ENTRA_TENANT_ID",
    ]);
  }

  private readonly fetchImpl: typeof fetch;
  private readonly fallback = new NoneDirectoryProvider();

  public constructor(private readonly opts: EntraDirectoryProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public listSubscriptionUsage(
    tenantId: string,
    now: Date,
  ): Promise<readonly DirectorySubscriptionUsage[]> {
    return withProviderFallback(
      {
        adapterKind: "directory",
        provider: "microsoft_entra",
        operation: "listSubscriptionUsage",
        tenantId,
      },
      this.opts,
      async () => {
        const token = await this.token();
        const raw = await fetchJson(
          this.fetchImpl,
          "https://graph.microsoft.com/v1.0/users?$select=displayName,mail,userPrincipalName,accountEnabled,signInActivity",
          {
            method: "GET",
            headers: bearerHeaders(token),
          },
        );
        return [usageFromDirectoryRows("microsoft_entra", raw, now)];
      },
      () => this.fallback.listSubscriptionUsage(tenantId, now),
    );
  }

  private async token(): Promise<string> {
    const raw = await fetchJson(
      this.fetchImpl,
      `https://login.microsoftonline.com/${encodeURIComponent(this.opts.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }).toString(),
      },
    );
    return (raw as { access_token?: string }).access_token ?? "";
  }
}

export interface OktaDirectoryProviderOptions extends ProviderAdapterOptions {
  readonly apiToken: string;
  readonly domain: string;
}

export class OktaDirectoryProvider implements DirectoryProvider {
  public readonly kind = "okta" as const;

  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    return providerSetup("okta", env, ["OKTA_API_TOKEN", "OKTA_DOMAIN"]);
  }

  private readonly fetchImpl: typeof fetch;
  private readonly fallback = new NoneDirectoryProvider();

  public constructor(private readonly opts: OktaDirectoryProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public listSubscriptionUsage(
    tenantId: string,
    now: Date,
  ): Promise<readonly DirectorySubscriptionUsage[]> {
    return withProviderFallback(
      { adapterKind: "directory", provider: "okta", operation: "listSubscriptionUsage", tenantId },
      this.opts,
      async () => {
        const raw = await fetchJson(
          this.fetchImpl,
          `https://${this.opts.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/api/v1/users?limit=200`,
          {
            method: "GET",
            headers: { authorization: `SSWS ${this.opts.apiToken}`, accept: "application/json" },
          },
        );
        return [usageFromDirectoryRows("okta", raw, now)];
      },
      () => this.fallback.listSubscriptionUsage(tenantId, now),
    );
  }
}

export interface HttpSaaSVendorApiOptions extends ProviderAdapterOptions {
  readonly provider: "adobe_admin" | "slack_admin" | "microsoft_365_admin" | "notion_admin";
  readonly token?: string;
  readonly endpoint?: string;
  readonly notification?: NotificationService;
}

export class HttpSaaSVendorApi implements SaaSVendorApi {
  public constructor(private readonly opts: HttpSaaSVendorApiOptions) {}

  public async requestSeatDowngrade(input: {
    readonly tenant_id: string;
    readonly subscription_id: string;
    readonly seats: number;
  }): Promise<SaaSVendorApiResult> {
    if (this.opts.token === undefined || this.opts.endpoint === undefined) {
      return this.emailFallback(input);
    }
    return withProviderFallback(
      {
        adapterKind: "saas_vendor",
        provider: this.opts.provider,
        operation: "requestSeatDowngrade",
        tenantId: input.tenant_id,
      },
      this.opts,
      async (): Promise<SaaSVendorApiResult> => {
        await fetchJson(this.opts.fetchImpl ?? fetch, this.opts.endpoint!, {
          method: "POST",
          headers: bearerHeaders(this.opts.token!),
          body: JSON.stringify({
            subscription_id: input.subscription_id,
            seats: input.seats,
          }),
        });
        return { status: "submitted" };
      },
      () => this.emailFallback(input),
    );
  }

  private async emailFallback(input: {
    readonly tenant_id: string;
    readonly subscription_id: string;
    readonly seats: number;
  }): Promise<SaaSVendorApiResult> {
    if (this.opts.notification !== undefined) {
      await this.opts.notification.email(
        "vendor-sales@example.invalid",
        "Seat downgrade request",
        `Tenant ${input.tenant_id} requests ${input.seats} seats for ${input.subscription_id}.`,
      );
    }
    return { status: "unsupported", note: "vendor_sales_email_drafted" };
  }
}

export class AdobeAdminConsoleApi extends HttpSaaSVendorApi {
  public constructor(opts: Omit<HttpSaaSVendorApiOptions, "provider">) {
    super({ ...opts, provider: "adobe_admin" });
  }
}

export class SlackAdminApi extends HttpSaaSVendorApi {
  public constructor(opts: Omit<HttpSaaSVendorApiOptions, "provider">) {
    super({ ...opts, provider: "slack_admin" });
  }
}

export class Microsoft365AdminApi extends HttpSaaSVendorApi {
  public constructor(opts: Omit<HttpSaaSVendorApiOptions, "provider">) {
    super({ ...opts, provider: "microsoft_365_admin" });
  }
}

export class NotionAdminApi extends HttpSaaSVendorApi {
  public constructor(opts: Omit<HttpSaaSVendorApiOptions, "provider">) {
    super({ ...opts, provider: "notion_admin" });
  }
}

function usageFromDirectoryRows(
  subscriptionId: string,
  raw: unknown,
  now: Date,
): DirectorySubscriptionUsage {
  const rows = Array.isArray(raw)
    ? raw
    : ((raw as { users?: unknown[]; value?: unknown[] }).users ??
      (raw as { value?: unknown[] }).value ??
      []);
  const activeUsers = rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .filter(
      (row) => row.status === "ACTIVE" || row.accountEnabled === true || row.suspended === false,
    )
    .map((row) => {
      const profile = (row.profile ?? {}) as Record<string, unknown>;
      return {
        name: stringValue(row.displayName ?? profile.displayName ?? profile.login ?? row.name),
        email: stringValue(row.mail ?? row.userPrincipalName ?? profile.email ?? profile.login),
        last_active: stringValue(
          row.lastLogin ??
            (row.signInActivity as { lastSignInDateTime?: string } | undefined)
              ?.lastSignInDateTime ??
            now.toISOString(),
        ),
        apps_used: [],
      };
    });
  return {
    subscription_id: subscriptionId,
    merchant: subscriptionId,
    licensed: activeUsers.length,
    active_30d: activeUsers.length,
    active_users: activeUsers,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}
