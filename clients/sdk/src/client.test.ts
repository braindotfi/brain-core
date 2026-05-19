import { describe, expect, it, vi } from "vitest";

import { createBrainHttpClient } from "./client.js";

describe("createBrainHttpClient", () => {
  it("throws when apiKey is empty", () => {
    expect(() => createBrainHttpClient({ apiKey: "" })).toThrow(/apiKey is required/);
  });

  it("sends Authorization header and uses the default base URL", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const http = createBrainHttpClient({
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await http.GET("/audit/anchor/latest");

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://api.brain.fi/v1/audit/anchor/latest");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
  });

  it("honors a custom baseUrl", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const http = createBrainHttpClient({
      apiKey: "k",
      baseUrl: "https://api.sandbox.brain.fi/v1",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await http.GET("/audit/anchor/latest");

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://api.sandbox.brain.fi/v1/audit/anchor/latest");
  });

  it("merges extra headers", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const http = createBrainHttpClient({
      apiKey: "k",
      headers: { "X-Trace-Id": "trace-123" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await http.GET("/audit/anchor/latest");

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.headers.get("x-trace-id")).toBe("trace-123");
    expect(request.headers.get("authorization")).toBe("Bearer k");
  });
});
