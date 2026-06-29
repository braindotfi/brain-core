import { WebClient } from "@slack/web-api";
import type { SlackClient } from "../surfaces/slack/adapter.js";

export interface SlackTokenProvider {
  tokenForTenant(tenantId: string): Promise<string>;
}

export class SlackWebApiClient implements SlackClient {
  private readonly fixedClient: WebClient | undefined;
  private readonly tokenProvider: SlackTokenProvider | undefined;
  private readonly clientsByToken = new Map<string, WebClient>();

  constructor(tokenOrClient: string | WebClient | SlackTokenProvider) {
    if (typeof tokenOrClient === "string") {
      this.fixedClient = new WebClient(tokenOrClient);
      this.tokenProvider = undefined;
      return;
    }
    if (isTokenProvider(tokenOrClient)) {
      this.fixedClient = undefined;
      this.tokenProvider = tokenOrClient;
      return;
    }
    this.fixedClient = tokenOrClient;
    this.tokenProvider = undefined;
  }

  async postMessage(args: {
    tenantId?: string | undefined;
    channel: string;
    text: string;
    blocks: unknown[];
  }): Promise<{ ok: boolean; ts?: string; error?: string }> {
    const client = await this.clientFor(args.tenantId);
    const response = await client.chat.postMessage({
      channel: args.channel,
      text: args.text,
      blocks: args.blocks as never[],
    });
    return {
      ok: response.ok === true,
      ...(typeof response.ts === "string" ? { ts: response.ts } : {}),
      ...(typeof response.error === "string" ? { error: response.error } : {}),
    };
  }

  async update(args: {
    tenantId?: string | undefined;
    channel: string;
    ts: string;
    text: string;
    blocks: unknown[];
  }): Promise<{ ok: boolean; error?: string }> {
    const client = await this.clientFor(args.tenantId);
    const response = await client.chat.update({
      channel: args.channel,
      ts: args.ts,
      text: args.text,
      blocks: args.blocks as never[],
    });
    return {
      ok: response.ok === true,
      ...(typeof response.error === "string" ? { error: response.error } : {}),
    };
  }

  private async clientFor(tenantId: string | undefined): Promise<WebClient> {
    if (this.fixedClient !== undefined) return this.fixedClient;
    if (this.tokenProvider === undefined) throw new Error("slack_client_not_configured");
    if (tenantId === undefined || tenantId.length === 0) {
      throw new Error("slack_tenant_id_required");
    }
    const token = await this.tokenProvider.tokenForTenant(tenantId);
    const existing = this.clientsByToken.get(token);
    if (existing !== undefined) return existing;
    const client = new WebClient(token);
    this.clientsByToken.set(token, client);
    return client;
  }
}

function isTokenProvider(value: WebClient | SlackTokenProvider): value is SlackTokenProvider {
  return "tokenForTenant" in value && typeof value.tokenForTenant === "function";
}
