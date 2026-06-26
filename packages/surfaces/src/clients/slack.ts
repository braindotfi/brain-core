import { WebClient } from "@slack/web-api";
import type { SlackClient } from "../surfaces/slack/adapter.js";

export class SlackWebApiClient implements SlackClient {
  private readonly client: WebClient;

  constructor(tokenOrClient: string | WebClient) {
    this.client = typeof tokenOrClient === "string" ? new WebClient(tokenOrClient) : tokenOrClient;
  }

  async postMessage(args: {
    channel: string;
    text: string;
    blocks: unknown[];
  }): Promise<{ ok: boolean; ts?: string; error?: string }> {
    const response = await this.client.chat.postMessage({
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
    channel: string;
    ts: string;
    text: string;
    blocks: unknown[];
  }): Promise<{ ok: boolean; error?: string }> {
    const response = await this.client.chat.update({
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
}
