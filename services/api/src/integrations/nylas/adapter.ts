import { randomUUID } from "node:crypto";

export const NYLAS_SCOPES = [
  "email.send",
  "email.compose",
  "email.readonly",
  "email.metadata",
  "calendar.readonly",
] as const;

export type NylasAdapterMode = "real" | "mock";

export interface NylasAdapterOptions {
  readonly mode: NylasAdapterMode;
  readonly clientId?: string;
  readonly apiKey?: string;
  readonly apiUri: string;
  readonly redirectUri: string;
  readonly fetchImpl?: typeof fetch;
}

export interface NylasGrant {
  readonly grantId: string;
  readonly provider: "gmail" | "outlook" | "imap";
  readonly email: string;
  readonly scope: string[];
}

export interface NylasSendEmailInput {
  readonly grantId: string;
  readonly to: string[];
  readonly subject: string;
  readonly body: string;
  readonly replyTo: string;
  readonly threadId?: string;
}

export interface NylasSendEmailResult {
  readonly messageId: string;
  readonly threadId: string;
}

export interface NylasThread {
  readonly id: string;
  readonly subject?: string;
  readonly participants?: unknown[];
  readonly messages?: unknown[];
}

export interface NylasEmailParticipant {
  readonly name?: string;
  readonly email: string;
}

export interface NylasMessage {
  readonly id: string;
  readonly from: NylasEmailParticipant;
  readonly to: NylasEmailParticipant[];
  readonly subject: string;
  readonly snippet: string;
  readonly bodyHtml?: string;
  readonly bodyText?: string;
  readonly receivedAt: string;
}

export class NylasHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly retryAfter: string | null,
  ) {
    super(`nylas_http_${status}`);
  }
}

export class NylasAdapter {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly opts: NylasAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public getAuthUrl(input: { tenantId: string; redirectUri?: string }): string {
    const redirectUri = input.redirectUri ?? this.opts.redirectUri;
    const state = encodeState(input.tenantId);
    if (this.opts.mode === "mock") {
      const url = new URL(redirectUri);
      url.searchParams.set("code", "mock_code");
      url.searchParams.set("state", state);
      return url.toString();
    }
    const clientId = required(this.opts.clientId, "NYLAS_CLIENT_ID");
    const url = new URL("/v3/connect/auth", this.opts.apiUri);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("scope", NYLAS_SCOPES.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  public async exchangeCode(input: {
    code: string;
    state: string;
    redirectUri?: string;
  }): Promise<NylasGrant> {
    decodeState(input.state);
    if (this.opts.mode === "mock") {
      return {
        grantId: `mock_${shortId()}`,
        provider: "gmail",
        email: "you@example.com",
        scope: ["email.send"],
      };
    }
    const json = await this.request(
      "/v3/connect/token",
      {
        method: "POST",
        body: JSON.stringify({
          client_id: required(this.opts.clientId, "NYLAS_CLIENT_ID"),
          client_secret: required(this.opts.apiKey, "NYLAS_API_KEY"),
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: input.redirectUri ?? this.opts.redirectUri,
        }),
      },
      { authenticated: false },
    );
    return {
      grantId: requiredString(json, ["grant_id"]),
      provider: providerFrom(requiredString(json, ["provider"])),
      email: requiredString(json, ["email"]),
      scope: stringArray(json["scope"]),
    };
  }

  public async sendEmail(input: NylasSendEmailInput): Promise<NylasSendEmailResult> {
    if (this.opts.mode === "mock") {
      return { messageId: `mock_msg_${shortId()}`, threadId: `mock_thread_${shortId()}` };
    }
    const json = await this.request(
      `/v3/grants/${encodeURIComponent(input.grantId)}/messages/send`,
      {
        method: "POST",
        headers: { "Idempotency-Key": `collections:${input.grantId}:${input.subject}` },
        body: JSON.stringify({
          to: input.to.map((email) => ({ email })),
          subject: input.subject,
          body: input.body,
          reply_to: [{ email: input.replyTo }],
          ...(input.threadId !== undefined ? { thread_id: input.threadId } : {}),
        }),
      },
    );
    const data = readObject(json["data"]) ?? json;
    return {
      messageId: requiredString(data, ["id", "message_id"]),
      threadId: requiredString(data, ["thread_id"]),
    };
  }

  public async getThread(input: { grantId: string; threadId: string }): Promise<NylasThread> {
    if (this.opts.mode === "mock") return { id: input.threadId, messages: [] };
    const json = await this.request(
      `/v3/grants/${encodeURIComponent(input.grantId)}/threads/${encodeURIComponent(input.threadId)}`,
      { method: "GET" },
    );
    return (readObject(json["data"]) ?? json) as unknown as NylasThread;
  }

  public async listMessages(input: {
    grantId: string;
    threadId: string;
  }): Promise<NylasMessage[]> {
    if (this.opts.mode === "mock") {
      return [
        {
          id: "mock_msg_outbound",
          from: { name: "You", email: "you@example.com" },
          to: [{ name: "Customer", email: "customer@example.com" }],
          subject: "Invoice reminder",
          snippet: "Following up on the open invoice.",
          bodyHtml: "<p>Following up on the open invoice.</p>",
          bodyText: "Following up on the open invoice.",
          receivedAt: "2026-09-24T08:00:00.000Z",
        },
        {
          id: "mock_msg_inbound",
          from: { name: "Customer", email: "customer@example.com" },
          to: [{ name: "You", email: "you@example.com" }],
          subject: "Re: Invoice reminder",
          snippet: "We will send payment today.",
          bodyHtml: "<p>We will send payment today.</p>",
          bodyText: "We will send payment today.",
          receivedAt: "2026-09-24T09:00:00.000Z",
        },
      ];
    }
    const list = await this.request(
      `/v3/grants/${encodeURIComponent(input.grantId)}/messages?thread_id=${encodeURIComponent(
        input.threadId,
      )}`,
      { method: "GET" },
    );
    const rows = readArray(list["data"]).map(readMessageSummary).filter(isMessageSummary);
    return Promise.all(
      rows.map(async (summary) => {
        if (summary.bodyHtml !== undefined || summary.bodyText !== undefined) return summary;
        const detail = await this.request(
          `/v3/grants/${encodeURIComponent(input.grantId)}/messages/${encodeURIComponent(
            summary.id,
          )}?fields=body`,
          { method: "GET" },
        );
        const bodySource = readObject(detail["data"]) ?? detail;
        return {
          ...summary,
          ...readMessageBody(bodySource),
        };
      }),
    );
  }

  public async disconnect(input: { grantId: string }): Promise<void> {
    if (this.opts.mode === "mock") return;
    await this.request(`/v3/grants/${encodeURIComponent(input.grantId)}`, { method: "DELETE" });
  }

  private async request(
    path: string,
    init: NonNullable<Parameters<typeof fetch>[1]>,
    options: { authenticated?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (options.authenticated !== false) {
      headers.set("authorization", `Bearer ${required(this.opts.apiKey, "NYLAS_API_KEY")}`);
    }
    const url = new URL(path, this.opts.apiUri);
    const res = await retry429(() => this.fetchImpl(url, { ...init, headers }), 2);
    if (!res.ok) throw new NylasHttpError(res.status, res.headers.get("retry-after"));
    if (res.status === 204) return {};
    return (await res.json()) as Record<string, unknown>;
  }
}

export function encodeState(tenantId: string): string {
  return Buffer.from(JSON.stringify({ tenantId })).toString("base64url");
}

export function decodeState(state: string): { tenantId: string } {
  const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
    tenantId?: unknown;
  };
  if (typeof parsed.tenantId !== "string" || parsed.tenantId.length === 0) {
    throw new Error("invalid_nylas_state");
  }
  return { tenantId: parsed.tenantId };
}

function providerFrom(value: string): NylasGrant["provider"] {
  if (value === "google" || value === "gmail") return "gmail";
  if (value === "microsoft" || value === "outlook") return "outlook";
  return "imap";
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/\s+/).filter((item) => item.length > 0);
  return [];
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(`missing_nylas_field_${keys[0]}`);
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readMessageSummary(value: unknown): NylasMessage | null {
  const row = readObject(value);
  if (row === undefined) return null;
  const id = stringValue(row["id"]);
  if (id.length === 0) return null;
  const from = firstParticipant(row["from"]);
  if (from === null) return null;
  return {
    id,
    from,
    to: readParticipants(row["to"]),
    subject: stringValue(row["subject"]),
    snippet: stringValue(row["snippet"]),
    ...readMessageBody(row),
    receivedAt: receivedAt(row),
  };
}

function isMessageSummary(value: NylasMessage | null): value is NylasMessage {
  return value !== null;
}

function readMessageBody(row: Record<string, unknown>): Pick<NylasMessage, "bodyHtml" | "bodyText"> {
  const bodyHtml = stringValue(row["body_html"]) || stringValue(row["body"]);
  const bodyText = stringValue(row["body_text"]);
  return {
    ...(bodyHtml.length > 0 ? { bodyHtml } : {}),
    ...(bodyText.length > 0 ? { bodyText } : {}),
  };
}

function readParticipants(value: unknown): NylasEmailParticipant[] {
  return readArray(value).map(readParticipant).filter(isParticipant);
}

function firstParticipant(value: unknown): NylasEmailParticipant | null {
  if (Array.isArray(value)) return readParticipant(value[0]);
  return readParticipant(value);
}

function readParticipant(value: unknown): NylasEmailParticipant | null {
  const row = readObject(value);
  if (row === undefined) return null;
  const email = stringValue(row["email"]);
  if (email.length === 0) return null;
  const name = stringValue(row["name"]);
  return {
    ...(name.length > 0 ? { name } : {}),
    email,
  };
}

function isParticipant(value: NylasEmailParticipant | null): value is NylasEmailParticipant {
  return value !== null;
}

function receivedAt(row: Record<string, unknown>): string {
  const date = stringValue(row["date"]) || stringValue(row["received_at"]);
  if (date.length > 0) return date;
  const timestamp = row["date"];
  if (typeof timestamp === "number") return new Date(timestamp * 1000).toISOString();
  return new Date(0).toISOString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function retry429(call: () => Promise<Response>, retries: number): Promise<Response> {
  let res = await call();
  for (let attempt = 0; res.status === 429 && attempt < retries; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    res = await call();
  }
  return res;
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
