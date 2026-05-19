import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthInvalidKeyError,
  BrainError,
  PolicyDeniedError,
  RateLimitedError,
  TenantNotFoundError,
} from "../errors/index.js";
import type { FetchLike } from "../index.js";
import { BrainHttp } from "./transport.js";

const BASE = "https://api.brain.dev/v1";
const KEY = "brain_sk_test_abc";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeFetch(response: () => Response): { fetch: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    // Lowercase header keys to mirror what a real `Headers` instance
    // does — call sites then read with stable lowercase names.
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders !== undefined) {
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(initHeaders)) {
        for (const [k, v] of initHeaders) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(initHeaders)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      ...(init?.body !== undefined ? { body: String(init.body) } : {}),
    });
    return response();
  };
  return { fetch, calls };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

let http: BrainHttp;
let calls: CapturedCall[];

function setup(respond: () => Response): void {
  const f = makeFetch(respond);
  calls = f.calls;
  http = new BrainHttp({ baseUrl: BASE, apiKey: KEY, fetch: f.fetch });
}

describe("BrainHttp — request construction", () => {
  beforeEach(() => {
    setup(() => jsonResponse(200, { ok: true }));
  });

  it("sends Authorization: Bearer <key> on every request", async () => {
    await http.get<unknown>("/ledger/accounts");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("sends Accept: application/json on every request", async () => {
    await http.get<unknown>("/ledger/accounts");
    expect(calls[0]?.headers.accept).toBe("application/json");
  });

  it("includes a User-Agent identifying the SDK", async () => {
    await http.get<unknown>("/ledger/accounts");
    expect(calls[0]?.headers["user-agent"]).toMatch(/brain-sdk-ts\/\d+\.\d+\.\d+/);
  });

  it("appends a User-Agent suffix when provided", async () => {
    const f = makeFetch(() => jsonResponse(200, {}));
    const customHttp = new BrainHttp({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: f.fetch,
      userAgent: "my-app/2.0",
    });
    await customHttp.get<unknown>("/x");
    expect(f.calls[0]?.headers["user-agent"]).toMatch(/brain-sdk-ts\/\d+\.\d+\.\d+ my-app\/2\.0/);
  });

  it("composes the URL from baseUrl + path", async () => {
    await http.get<unknown>("/ledger/accounts");
    expect(calls[0]?.url).toBe(`${BASE}/ledger/accounts`);
  });

  it("accepts a path without leading slash", async () => {
    await http.get<unknown>("ledger/accounts");
    expect(calls[0]?.url).toBe(`${BASE}/ledger/accounts`);
  });

  it("serializes query parameters and skips undefined values", async () => {
    await http.get<unknown>("/ledger/transactions", {
      query: {
        from: "2026-01-01",
        limit: 100,
        cursor: undefined,
        flag: true,
      },
    });
    expect(calls[0]?.url).toContain("from=2026-01-01");
    expect(calls[0]?.url).toContain("limit=100");
    expect(calls[0]?.url).toContain("flag=true");
    expect(calls[0]?.url).not.toContain("cursor=");
  });

  it("url-encodes query keys and values", async () => {
    await http.get<unknown>("/wiki/search", {
      query: { q: "AWS spend Q3 & EC2" },
    });
    expect(calls[0]?.url).toContain("q=AWS%20spend%20Q3%20%26%20EC2");
  });
});

describe("BrainHttp — body serialization", () => {
  beforeEach(() => {
    setup(() => jsonResponse(201, { id: "act_1" }));
  });

  it("serializes the body as JSON on POST", async () => {
    await http.post<unknown>("/actions", { foo: "bar" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toBe('{"foo":"bar"}');
  });

  it("does not set Content-Type when body is omitted", async () => {
    await http.del<unknown>("/actions/x");
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
  });
});

describe("BrainHttp — idempotency", () => {
  beforeEach(() => {
    setup(() => jsonResponse(202, {}));
  });

  it("injects Idempotency-Key on POST", async () => {
    await http.post<unknown>("/actions", {});
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^idem_[0-9a-f]{32}$/);
  });

  it("injects Idempotency-Key on PUT, PATCH, DELETE", async () => {
    await http.put<unknown>("/x", {});
    await http.patch<unknown>("/x", {});
    await http.del<unknown>("/x");
    for (const c of calls) {
      expect(c.headers["idempotency-key"]).toMatch(/^idem_[0-9a-f]{32}$/);
    }
  });

  it("does NOT inject Idempotency-Key on GET", async () => {
    await http.get<unknown>("/ledger/accounts");
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("honors caller-supplied idempotencyKey", async () => {
    await http.post<unknown>("/actions", {}, { idempotencyKey: "my_key_42" });
    expect(calls[0]?.headers["idempotency-key"]).toBe("my_key_42");
  });

  it("uses a fresh key per call when caller does not supply one", async () => {
    await http.post<unknown>("/actions", {});
    await http.post<unknown>("/actions", {});
    expect(calls[0]?.headers["idempotency-key"]).not.toBe(calls[1]?.headers["idempotency-key"]);
  });
});

describe("BrainHttp — response parsing", () => {
  it("returns parsed JSON on 2xx", async () => {
    setup(() => jsonResponse(200, { hello: "world" }));
    const result = await http.get<{ hello: string }>("/x");
    expect(result).toEqual({ hello: "world" });
  });

  it("returns undefined on 204 No Content", async () => {
    setup(() => new Response(null, { status: 204 }));
    const result = await http.del<undefined>("/x");
    expect(result).toBeUndefined();
  });

  it("handles 2xx with empty body", async () => {
    setup(() => new Response("", { status: 200 }));
    const result = await http.get<undefined>("/x");
    expect(result).toBeUndefined();
  });

  it("throws BrainError when a 2xx response is non-JSON", async () => {
    setup(() => new Response("not json", { status: 200 }));
    await expect(http.get<unknown>("/x")).rejects.toThrow(BrainError);
  });
});

describe("BrainHttp — error envelope parsing", () => {
  it("throws PolicyDeniedError for 422 + policy_denied envelope", async () => {
    setup(() =>
      jsonResponse(422, {
        error: {
          code: "policy_denied",
          message: "rule blocked it",
          details: { rule_id: "r-1" },
          trace_id: "trc_aaa",
          docs_url: "https://docs.brain.fi/errors/policy_denied",
        },
      }),
    );
    await expect(http.post<unknown>("/actions", {})).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it("throws TenantNotFoundError with details preserved", async () => {
    setup(() =>
      jsonResponse(404, {
        error: {
          code: "tenant_not_found",
          message: "no such tenant",
          trace_id: "trc_xyz",
        },
      }),
    );
    try {
      await http.get<unknown>("/ledger/accounts");
      throw new Error("expected error");
    } catch (e) {
      expect(e).toBeInstanceOf(TenantNotFoundError);
      expect((e as BrainError).traceId).toBe("trc_xyz");
      expect((e as BrainError).statusCode).toBe(404);
    }
  });

  it("synthesizes AuthInvalidKeyError when a 401 has no envelope", async () => {
    setup(() => new Response("Unauthorized", { status: 401 }));
    await expect(http.get<unknown>("/x")).rejects.toBeInstanceOf(AuthInvalidKeyError);
  });

  it("synthesizes RateLimitedError on 429 with non-JSON body", async () => {
    setup(() => new Response("Too Many Requests", { status: 429 }));
    await expect(http.get<unknown>("/x")).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("picks up trace id from x-brain-trace-id header on synthesized errors", async () => {
    setup(
      () =>
        new Response("nope", {
          status: 503,
          headers: { "x-brain-trace-id": "trc_header" },
        }),
    );
    try {
      await http.get<unknown>("/x");
    } catch (e) {
      expect((e as BrainError).traceId).toBe("trc_header");
    }
  });

  it("falls back to internal_error for unmapped status codes", async () => {
    setup(() => new Response("teapot", { status: 418 }));
    try {
      await http.get<unknown>("/x");
    } catch (e) {
      expect((e as BrainError).code).toBe("internal_error");
      expect((e as BrainError).statusCode).toBe(418);
    }
  });
});

describe("BrainHttp — network failures", () => {
  it("wraps fetch exceptions in upstream_timeout BrainError", async () => {
    const f: FetchLike = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const errHttp = new BrainHttp({ baseUrl: BASE, apiKey: KEY, fetch: f });
    try {
      await errHttp.get<unknown>("/x");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as BrainError).code).toBe("upstream_timeout");
      expect((e as BrainError).message).toMatch(/fetch failed/);
      expect((e as BrainError).cause).toBeInstanceOf(TypeError);
    }
  });

  it("forwards AbortSignal to fetch", async () => {
    const seen: AbortSignal[] = [];
    const f: FetchLike = async (_input, init) => {
      if (init?.signal !== undefined) seen.push(init.signal);
      return jsonResponse(200, {});
    };
    const aborted = new BrainHttp({ baseUrl: BASE, apiKey: KEY, fetch: f });
    const controller = new AbortController();
    await aborted.get<unknown>("/x", { signal: controller.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(controller.signal);
  });
});

describe("BrainHttp — custom headers", () => {
  beforeEach(() => {
    setup(() => jsonResponse(200, {}));
  });

  it("merges caller-supplied headers after defaults", async () => {
    await http.get<unknown>("/x", { headers: { "X-Custom": "value" } });
    expect(calls[0]?.headers["x-custom"]).toBe("value");
    // defaults still present
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("caller headers override SDK defaults when names collide", async () => {
    await http.get<unknown>("/x", {
      headers: { Authorization: "Bearer override" },
    });
    expect(calls[0]?.headers.authorization).toBe("Bearer override");
  });
});
