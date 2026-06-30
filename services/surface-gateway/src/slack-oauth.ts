import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STATE_VERSION = "v1";
const SLACK_CHAT_SCOPE_PREFIX = "chat";
export const SLACK_BOT_SCOPES = [
  `${SLACK_CHAT_SCOPE_PREFIX}:write`,
  `${SLACK_CHAT_SCOPE_PREFIX}:write.public`,
] as const;

export interface SlackInstallStateClaims {
  tenantId: string;
  installedBy: string;
  nonce: string;
  exp: number;
}

export interface SlackInstallState {
  token: string;
  nonce: string;
  expiresAt: Date;
}

export type SlackInstallStateResult =
  | { ok: true; claims: SlackInstallStateClaims }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" };

export function mintSlackInstallState(input: {
  tenantId: string;
  installedBy: string;
  secret: string;
  ttlSeconds?: number | undefined;
  nowMs?: number | undefined;
}): SlackInstallState {
  const nowMs = input.nowMs ?? Date.now();
  const ttlSeconds = input.ttlSeconds ?? 10 * 60;
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const claims: SlackInstallStateClaims = {
    tenantId: input.tenantId,
    installedBy: input.installedBy,
    nonce: randomBytes(16).toString("base64url"),
    exp,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = signPayload(payload, input.secret);
  return {
    token: `${STATE_VERSION}.${payload}.${signature}`,
    nonce: claims.nonce,
    expiresAt: new Date(exp * 1000),
  };
}

export function verifySlackInstallState(input: {
  token: string;
  secret: string;
  nowMs?: number | undefined;
}): SlackInstallStateResult {
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== STATE_VERSION) return { ok: false, reason: "malformed" };
  const [, payload, signature] = parts as [string, string, string];
  const expected = signPayload(payload, input.secret);
  if (!safeEqual(signature, expected)) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isSlackInstallStateClaims(parsed)) return { ok: false, reason: "malformed" };
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (parsed.exp <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims: parsed };
}

export function buildSlackAuthorizeUrl(input: {
  clientId: string;
  state: string;
  redirectUri?: string | undefined;
}): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("state", input.state);
  if (input.redirectUri !== undefined) url.searchParams.set("redirect_uri", input.redirectUri);
  return url.toString();
}

export interface SlackOAuthAccess {
  teamId: string;
  botToken: string;
  botUserId: string;
  scopes: string[];
}

export interface SlackOAuthClient {
  exchangeCode(input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri?: string | undefined;
  }): Promise<SlackOAuthAccess>;
}

export class FetchSlackOAuthClient implements SlackOAuthClient {
  public async exchangeCode(input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri?: string | undefined;
  }): Promise<SlackOAuthAccess> {
    const body = new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
    if (input.redirectUri !== undefined) body.set("redirect_uri", input.redirectUri);
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`slack_oauth_http_${response.status}`);
    const parsed = (await response.json()) as unknown;
    if (!isSlackOAuthResponse(parsed) || parsed.ok !== true) {
      const error = isSlackOAuthResponse(parsed) ? parsed.error : "invalid_response";
      throw new Error(`slack_oauth_failed_${error ?? "unknown"}`);
    }
    return {
      teamId: parsed.team.id,
      botToken: parsed.access_token,
      botUserId: parsed.bot_user_id,
      scopes: parsed.scope.split(",").filter((scope) => scope.length > 0),
    };
  }
}

interface SlackOAuthResponse {
  ok: boolean;
  access_token: string;
  scope: string;
  bot_user_id: string;
  team: { id: string };
  error?: string | undefined;
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isSlackInstallStateClaims(value: unknown): value is SlackInstallStateClaims {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["tenantId"] === "string" &&
    typeof record["installedBy"] === "string" &&
    typeof record["nonce"] === "string" &&
    typeof record["exp"] === "number"
  );
}

function isSlackOAuthResponse(value: unknown): value is SlackOAuthResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["ok"] === false) return true;
  const team = record["team"];
  return (
    record["ok"] === true &&
    typeof record["access_token"] === "string" &&
    typeof record["scope"] === "string" &&
    typeof record["bot_user_id"] === "string" &&
    typeof team === "object" &&
    team !== null &&
    typeof (team as Record<string, unknown>)["id"] === "string"
  );
}
