const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const AGENT_API_KEY_SUBJECT_TOKEN_TYPE = "urn:brain:params:oauth:token-type:agent-api-key";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const ACCESS_TOKEN_MAX_TTL_SECONDS = 300;
const EARLY_REFRESH_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;

export const DEFAULT_AGENT_TOKEN_URL = "https://auth.brain.fi/token";

export class AgentTokenExchangeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentTokenExchangeError";
  }
}

interface CachedAccessToken {
  readonly value: string;
  readonly expiresAt: number;
}

interface ExchangeResponse {
  readonly access_token?: unknown;
  readonly issued_token_type?: unknown;
  readonly token_type?: unknown;
  readonly expires_in?: unknown;
  readonly scope?: unknown;
  readonly refresh_token?: unknown;
}

export interface AgentTokenManagerOptions {
  readonly agentApiKey: string;
  readonly tokenUrl: string;
  readonly resource: string;
  readonly scope?: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => number;
}

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const encoded = token.split(".")[1];
  if (token.split(".").length !== 3 || encoded === undefined) return undefined;
  try {
    const base64 = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), "=");
    const parsed: unknown = JSON.parse(globalThis.atob(base64));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export class AgentTokenManager {
  private readonly now: () => number;
  private cached: CachedAccessToken | undefined;
  private exchangeInFlight: Promise<CachedAccessToken> | undefined;

  constructor(private readonly options: AgentTokenManagerOptions) {
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  async ready(): Promise<void> {
    await this.getAccessToken();
  }

  async getAccessToken(): Promise<string> {
    if (this.cached !== undefined && this.cached.expiresAt - this.now() > EARLY_REFRESH_SECONDS) {
      return this.cached.value;
    }
    return (await this.exchangeSingleFlight()).value;
  }

  async refreshAfterUnauthorized(failedToken: string): Promise<string> {
    if (
      this.cached !== undefined &&
      this.cached.value !== failedToken &&
      this.cached.expiresAt - this.now() > EARLY_REFRESH_SECONDS
    ) {
      return this.cached.value;
    }
    return (await this.exchangeSingleFlight()).value;
  }

  private exchangeSingleFlight(): Promise<CachedAccessToken> {
    if (this.exchangeInFlight !== undefined) return this.exchangeInFlight;
    const exchange = this.exchange();
    this.exchangeInFlight = exchange;
    const clear = (): void => {
      if (this.exchangeInFlight === exchange) this.exchangeInFlight = undefined;
    };
    void exchange.then(clear, clear);
    return exchange;
  }

  private async exchange(): Promise<CachedAccessToken> {
    const form = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: this.options.agentApiKey,
      subject_token_type: AGENT_API_KEY_SUBJECT_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      resource: this.options.resource,
    });
    if (this.options.scope !== undefined) form.set("scope", this.options.scope);

    let response: Response;
    let payload: ExchangeResponse;
    try {
      response = await this.options.fetch(this.options.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
      if (!response.ok) throw new Error(`token endpoint returned ${response.status}`);
      payload = (await response.json()) as ExchangeResponse;
    } catch (error) {
      throw new AgentTokenExchangeError("agent API key exchange failed", { cause: error });
    }

    const token = payload.access_token;
    const expiresIn = payload.expires_in;
    const effectiveScope = payload.scope;
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      payload.token_type !== "Bearer" ||
      payload.issued_token_type !== ACCESS_TOKEN_TYPE ||
      typeof expiresIn !== "number" ||
      !Number.isInteger(expiresIn) ||
      expiresIn <= 0 ||
      expiresIn > ACCESS_TOKEN_MAX_TTL_SECONDS ||
      typeof effectiveScope !== "string" ||
      effectiveScope.length === 0 ||
      payload.refresh_token !== undefined
    ) {
      throw new AgentTokenExchangeError("agent API key exchange returned an invalid response");
    }

    const claims = decodeJwtClaims(token);
    const now = Math.floor(this.now());
    const exp = claims?.["exp"];
    const iat = claims?.["iat"];
    const scopes = claims?.["scopes"];
    const issuer = claims?.["iss"];
    const tokenId = claims?.["jti"];
    const sub = claims?.["sub"];
    const tenantId = claims?.["tenant_id"];
    const credentialId = claims?.["credential_id"];
    if (
      claims === undefined ||
      typeof exp !== "number" ||
      !Number.isInteger(exp) ||
      typeof iat !== "number" ||
      !Number.isInteger(iat) ||
      exp <= now ||
      exp <= iat ||
      iat > now + CLOCK_SKEW_SECONDS ||
      exp - iat > ACCESS_TOKEN_MAX_TTL_SECONDS ||
      exp > now + ACCESS_TOKEN_MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS ||
      claims["aud"] !== this.options.resource ||
      typeof issuer !== "string" ||
      issuer.length === 0 ||
      claims["principal_type"] !== "agent" ||
      typeof sub !== "string" ||
      !sub.startsWith("agent_") ||
      typeof tenantId !== "string" ||
      !tenantId.startsWith("tnt_") ||
      typeof credentialId !== "string" ||
      !credentialId.startsWith("agkey_") ||
      typeof tokenId !== "string" ||
      !tokenId.startsWith("token_") ||
      !stringArray(scopes) ||
      scopes.join(" ") !== effectiveScope ||
      (this.options.scope !== undefined && effectiveScope !== this.options.scope)
    ) {
      throw new AgentTokenExchangeError("agent API key exchange returned an invalid access token");
    }

    const cached = { value: token, expiresAt: Math.min(exp, now + expiresIn) };
    this.cached = cached;
    return cached;
  }
}

export interface AgentAuthenticatedFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly ready: () => Promise<void>;
}

export function createAgentAuthenticatedFetch(
  options: AgentTokenManagerOptions,
): AgentAuthenticatedFetch {
  const manager = new AgentTokenManager(options);
  const authenticatedFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const original = new Request(input, init);
    let token = await manager.getAccessToken();

    const attempt = (accessToken: string): Promise<Response> => {
      const headers = new Headers(original.headers);
      headers.set("authorization", `Bearer ${accessToken}`);
      return options.fetch(new Request(original.clone(), { headers }));
    };

    let response = await attempt(token);
    if (response.status === 401) {
      token = await manager.refreshAfterUnauthorized(token);
      response = await attempt(token);
    }
    return response;
  };

  return {
    fetch: authenticatedFetch as typeof globalThis.fetch,
    ready: () => manager.ready(),
  };
}
