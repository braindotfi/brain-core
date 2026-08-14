import type { EmailClient } from "../surfaces/email/adapter.js";

export interface HttpEmailClientOptions {
  endpoint: string;
  apiKey: string;
  from?: string | undefined;
  senderResolver?: { senderForTenant(tenantId: string): Promise<string | null> } | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class HttpEmailClient implements EmailClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpEmailClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(args: {
    tenantId?: string | undefined;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string; rawBody?: string }> {
    const from =
      args.tenantId !== undefined
        ? ((await this.options.senderResolver?.senderForTenant(args.tenantId)) ?? this.options.from)
        : this.options.from;
    const response = await this.fetchImpl(this.options.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...(from !== undefined ? { from } : {}),
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
    // Read the body once as text; parse it as JSON from that text rather than
    // calling response.json() (which would consume the body a second time).
    const text = await response.text();
    const body = parseJson(text);
    return {
      ok: response.ok,
      ...(typeof body?.messageId === "string" ? { messageId: body.messageId } : {}),
      ...(!response.ok
        ? {
            error: typeof body?.error === "string" ? body.error : response.statusText,
            // Providers disagree on their error field name (SendGrid uses
            // errors[], Postmark uses Message, ...), so `error` above is
            // often just the generic HTTP reason phrase. Callers that need
            // the provider's actual rejection reason (e.g. to log it
            // server-side without exposing it to a public caller) read this
            // instead.
            ...(text.length > 0 ? { rawBody: text } : {}),
          }
        : {}),
    };
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const body = JSON.parse(text) as unknown;
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
