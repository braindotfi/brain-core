import { describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "../index.js";

interface Call {
  url: string;
  method: string;
  body?: string;
}

function makeBrain(response: unknown): { brain: Brain; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { body: String(init.body) } : {}),
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { brain: new Brain({ apiKey: "brain_sk_test_x", fetch }), calls };
}

describe("brain.sources.connect", () => {
  it("POSTs to /sources with tenantId + type + credentials", async () => {
    const { brain, calls } = makeBrain({
      id: "src_1",
      type: "plaid",
      status: "active",
      is_stub: false,
    });
    await brain.sources.connect({
      tenantId: "acme",
      type: "plaid",
      credentials: { access_token: "access-test-abc" },
      metadata: { label: "ops" },
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/sources");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.tenantId).toBe("acme");
    expect(body.type).toBe("plaid");
    expect(body.credentials.access_token).toBe("access-test-abc");
    expect(body.metadata).toEqual({ label: "ops" });
  });
});

describe("brain.sources.list / get", () => {
  it("list() hits GET /sources with filters", async () => {
    const { brain, calls } = makeBrain({ data: [], next_cursor: null });
    await brain.sources.list({
      tenantId: "acme",
      type: "plaid",
      status: "active",
      limit: 10,
    });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/sources");
    expect(calls[0]?.url).toContain("tenantId=acme");
    expect(calls[0]?.url).toContain("type=plaid");
    expect(calls[0]?.url).toContain("status=active");
    expect(calls[0]?.url).toContain("limit=10");
  });

  it("get() URL-encodes the source id", async () => {
    const { brain, calls } = makeBrain({ id: "src_x/y" });
    await brain.sources.get("src_x/y");
    expect(calls[0]?.url).toContain("/sources/src_x%2Fy");
  });
});

describe("brain.sources.disconnect / sync", () => {
  it("disconnect() issues DELETE", async () => {
    const { brain, calls } = makeBrain({ id: "src_1", status: "disconnected" });
    await brain.sources.disconnect("src_1");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/sources/src_1");
  });

  it("sync() POSTs and surfaces the `notes: stub` field when present", async () => {
    const { brain, calls } = makeBrain({
      job_id: "sjob_1",
      source_id: "src_1",
      status: "enqueued",
      notes: "stub",
    });
    const job = await brain.sources.sync("src_1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/sources/src_1/sync");
    expect(job.notes).toBe("stub");
  });
});
