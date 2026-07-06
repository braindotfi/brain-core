import { brainError, type ServiceCallContext } from "@brain/shared";
import { signAgentRequest } from "./sign-agent-request.js";

export interface DocumentExtractClientOptions {
  /** Shared HMAC secret for the X-Brain-Auth header. */
  signingSecret?: string;
}

export interface DocumentExtractInput {
  rawId: string;
  mimeType: string;
  documentB64: string;
  agentId: string;
}

export interface DocumentExtractResult {
  parsed_id: string;
  confidence: number;
}

export class DocumentExtractClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly opts: DocumentExtractClientOptions = {},
  ) {}

  public async extract(
    ctx: ServiceCallContext,
    input: DocumentExtractInput,
  ): Promise<DocumentExtractResult> {
    const body = JSON.stringify({
      agent_id: input.agentId,
      tenant_id: ctx.tenantId,
      raw_id: input.rawId,
      document_b64: input.documentB64,
      mime_type: input.mimeType,
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.signingSecret !== undefined) {
      headers["X-Brain-Auth"] = signAgentRequest(this.opts.signingSecret, body);
    }

    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/run/document_extract`, {
        method: "POST",
        headers,
        body,
      });
    } catch (cause) {
      throw brainError("internal_server_error", "document extraction agent unreachable", { cause });
    }

    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 422) {
        throw brainError("raw_source_unsupported", "document extraction agent rejected artifact", {
          statusOverride: 422,
          details: { upstream_status: resp.status, upstream_body: text },
        });
      }
      throw brainError(
        "internal_server_error",
        `document extraction agent returned ${String(resp.status)}: ${text}`,
      );
    }

    return (await resp.json()) as DocumentExtractResult;
  }
}
