import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, operations } from "../generated/openapi.js";

export type TenantExportJob = components["schemas"]["TenantExportJob"];
export type ProductionAgentToken = components["schemas"]["ProductionAgentToken"];

export type CreateTenantBody = NonNullable<
  operations["createTenant"]["requestBody"]
>["content"]["application/json"];
export type CreateTenantResult =
  operations["createTenant"]["responses"]["201"]["content"]["application/json"];

export type MintAgentTokenBody = NonNullable<
  operations["mintProductionAgentToken"]["requestBody"]
>["content"]["application/json"];

export type LinkWalletBody = NonNullable<
  operations["linkWallet"]["requestBody"]
>["content"]["application/json"];
export type LinkWalletResult =
  operations["linkWallet"]["responses"]["201"]["content"]["application/json"];

export type IssueApiKeyBody = NonNullable<
  operations["issueApiKey"]["requestBody"]
>["content"]["application/json"];
export type IssueApiKeyResult =
  operations["issueApiKey"]["responses"]["201"]["content"]["application/json"];

export type ListApiKeysResult =
  operations["listApiKeys"]["responses"]["200"]["content"]["application/json"];

export type RotateApiKeyResult =
  operations["rotateApiKey"]["responses"]["201"]["content"]["application/json"];

export type GetApiKeyUsageParams = NonNullable<operations["getTenantUsage"]["parameters"]["query"]>;
export type GetApiKeyUsageResult =
  operations["getTenantUsage"]["responses"]["200"]["content"]["application/json"];

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class TenantsResource {
  constructor(private readonly http: BrainHttpClient) {}

  /**
   * `security: []`, gated by the `X-Platform-Service-Auth` shared secret
   * header (`BRAIN_PLATFORM_SERVICE_SECRET`), not a bearer token. Creates a
   * production tenant, its bootstrap admin member, a member session, and
   * the tenant's propose-only BFF service agent token, all atomically.
   */
  async create(platformServiceAuth: string, body: CreateTenantBody): Promise<CreateTenantResult> {
    const { data, error, response } = await this.http.POST("/tenants", {
      body,
      headers: { "X-Platform-Service-Auth": platformServiceAuth },
    });
    // The 401 response is a spec-level `oneOf` (standard Error envelope, OR a
    // bare `{ reason: "platform_service_credential_required" }` when the demo
    // provisioning header was also present), BrainAPIError degrades the
    // latter shape to code "unknown" via its `body?.error` optional access.
    return unwrap(data, error as BrainErrorBody | undefined, response.status);
  }

  /**
   * Organization-scoped alias for `create`, identical handler server-side
   * (`createProductionTenant` in `production-tenancy/routes.ts`), just
   * nested under an org id in the path. `org_id` is echoed back in the
   * response; it isn't validated against anything else server-side, it's
   * a routing convenience for platforms that group tenants under an
   * organization. Kept as a separate method rather than an optional param
   * on `create` so `create`'s existing signature never changes.
   */
  async createForOrg(
    platformServiceAuth: string,
    orgId: string,
    body: CreateTenantBody,
  ): Promise<CreateTenantResult> {
    const { data, error, response } = await this.http.POST("/orgs/{orgId}/tenants", {
      params: { path: { orgId } },
      body,
      headers: { "X-Platform-Service-Auth": platformServiceAuth },
    });
    return unwrap(data, error as BrainErrorBody | undefined, response.status);
  }

  /**
   * `security: []`, same `X-Platform-Service-Auth` header as `create`.
   * Returns the active BFF service agent token, or mints one if none
   * exists. Pass `{ rotate: true }` to revoke the prior token and mint a
   * replacement.
   */
  async mintAgentToken(
    platformServiceAuth: string,
    tenantId: string,
    body: MintAgentTokenBody = {},
  ): Promise<ProductionAgentToken> {
    const { data, error, response } = await this.http.POST("/tenants/{tenantId}/agent-token", {
      params: { path: { tenantId } },
      body,
      headers: { "X-Platform-Service-Auth": platformServiceAuth },
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Owner JWT required (`policy:write`). Links a wallet address to the
   * tenant so it can sign in via `brain.auth.siwx` afterward. Registered
   * only when self-serve onboarding is enabled server-side.
   */
  async linkWallet(tenantId: string, body: LinkWalletBody): Promise<LinkWalletResult> {
    const { data, error, response } = await this.http.POST("/tenants/{tenant_id}/wallets", {
      params: { path: { tenant_id: tenantId } },
      body,
    });
    return unwrap(data, error, response.status);
  }

  async export(tenantId: string): Promise<TenantExportJob> {
    const { data, error, response } = await this.http.POST("/tenants/{id}/export", {
      params: { path: { id: tenantId } },
    });
    return unwrap(data, error, response.status);
  }

  async getExport(tenantId: string, jobId: string): Promise<TenantExportJob> {
    const { data, error, response } = await this.http.GET("/tenants/{id}/export/{job_id}", {
      params: { path: { id: tenantId, job_id: jobId } },
    });
    return unwrap(data, error, response.status);
  }

  async downloadExport(tenantId: string, jobId: string): Promise<string> {
    const { data, error, response } = await this.http.GET(
      "/tenants/{id}/export/{job_id}/download",
      {
        params: { path: { id: tenantId, job_id: jobId } },
        parseAs: "text",
      },
    );
    return unwrap(data, error, response.status);
  }

  /**
   * Requires a same-tenant admin session (`execution:admin`). Issues a
   * `brain_sk_test_`/`brain_sk_live_` bearer key, used directly as
   * `Authorization: Bearer <secret>` (no exchange step). The plaintext
   * `secret` is returned exactly once, in this response only.
   */
  async createApiKey(tenantId: string, body: IssueApiKeyBody): Promise<IssueApiKeyResult> {
    const { data, error, response } = await this.http.POST("/tenants/{tenantId}/keys", {
      params: { path: { tenantId } },
      body,
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires a same-tenant admin session. Returns masked key metadata only;
   * the plaintext secret is never re-exposed after issuance or rotation.
   */
  async listApiKeys(tenantId: string): Promise<ListApiKeysResult> {
    const { data, error, response } = await this.http.GET("/tenants/{tenantId}/keys", {
      params: { path: { tenantId } },
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires a same-tenant admin session. Atomically revokes the given key
   * and issues a replacement with the same name/environment/scopes. The new
   * plaintext secret is returned exactly once, in this response only.
   */
  async rotateApiKey(keyId: string): Promise<RotateApiKeyResult> {
    const { data, error, response } = await this.http.POST("/keys/{keyId}/rotate", {
      params: { path: { keyId } },
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires a same-tenant admin session. Sets `revoked_at`; keys are never
   * hard-deleted. Revoking an already-revoked key is a no-op 204, not an
   * error.
   */
  async revokeApiKey(keyId: string): Promise<void> {
    const { error, response } = await this.http.DELETE("/keys/{keyId}", {
      params: { path: { keyId } },
    });
    if (error !== undefined) {
      throw new BrainAPIError(response.status, error);
    }
  }

  /**
   * Requires a same-tenant admin session with `audit:read`. Per-key usage
   * event counts over `params.window` (default `30d`), optionally filtered
   * by `environment` or a single `key_id`.
   */
  async getApiKeyUsage(
    tenantId: string,
    params: GetApiKeyUsageParams = {},
  ): Promise<GetApiKeyUsageResult> {
    const { data, error, response } = await this.http.GET("/tenants/{tenantId}/usage", {
      params: { path: { tenantId }, query: params },
    });
    return unwrap(data, error, response.status);
  }
}
