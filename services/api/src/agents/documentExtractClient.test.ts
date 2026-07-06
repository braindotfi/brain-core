import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type ServiceCallContext } from "@brain/shared";
import { DocumentExtractClient } from "./documentExtractClient.js";
import { signAgentRequest } from "./sign-agent-request.js";

const CTX: ServiceCallContext = {
  tenantId: "tnt_01TEST000000000000000000000",
  actor: "agent_01TEST000000000000000000",
  principalType: "agent",
  scopes: ["raw:write"],
};

describe("DocumentExtractClient.extract", () => {
  const BASE_URL = "http://agents.internal";
  const BODY = {
    agent_id: "document_extractor",
    tenant_id: CTX.tenantId,
    raw_id: "raw_01TEST000000000000000000000",
    document_b64: Buffer.from("invoice").toString("base64"),
    mime_type: "application/pdf",
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ parsed_id: "prs_01TEST000000000000000000000", confidence: 0.91 }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the signed document extraction request with the expected body", async () => {
    const client = new DocumentExtractClient(BASE_URL, { signingSecret: "secret" });

    await client.extract(CTX, {
      rawId: BODY.raw_id,
      mimeType: BODY.mime_type,
      documentB64: BODY.document_b64,
      agentId: BODY.agent_id,
    });

    const expectedBody = JSON.stringify(BODY);
    expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/run/document_extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Brain-Auth": signAgentRequest("secret", expectedBody),
      },
      body: expectedBody,
    });
  });

  it("returns parsed id and confidence from a successful response", async () => {
    const client = new DocumentExtractClient(BASE_URL);
    await expect(
      client.extract(CTX, {
        rawId: BODY.raw_id,
        mimeType: BODY.mime_type,
        documentB64: BODY.document_b64,
        agentId: BODY.agent_id,
      }),
    ).resolves.toEqual({ parsed_id: "prs_01TEST000000000000000000000", confidence: 0.91 });
  });

  it("passes unsupported document responses through as HTTP 422", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "unsupported" }),
    );
    const client = new DocumentExtractClient(BASE_URL);

    await expect(
      client.extract(CTX, {
        rawId: BODY.raw_id,
        mimeType: BODY.mime_type,
        documentB64: BODY.document_b64,
        agentId: BODY.agent_id,
      }),
    ).rejects.toMatchObject({ code: "raw_source_unsupported", statusCode: 422 });
  });

  it("maps unreachable agent service to internal_server_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const client = new DocumentExtractClient(BASE_URL);

    await expect(
      client.extract(CTX, {
        rawId: BODY.raw_id,
        mimeType: BODY.mime_type,
        documentB64: BODY.document_b64,
        agentId: BODY.agent_id,
      }),
    ).rejects.toMatchObject({ code: "internal_server_error" });
  });
});
