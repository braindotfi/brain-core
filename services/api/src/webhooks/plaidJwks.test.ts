import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPlaidKeyResolver } from "./plaidJwks.js";

const opts = { clientId: "client-id", secret: "secret", env: "sandbox" as const };

const fakeKey = { kty: "EC", crv: "P-256", x: "abc", y: "def", use: "sig", kid: "kid-1" };

function mockFetch(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 400,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

describe("createPlaidKeyResolver", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and caches a key on first call", async () => {
    mockFetch({ key: fakeKey });
    const resolver = createPlaidKeyResolver(opts);

    const result = await resolver("kid-1");
    expect(result).toEqual(fakeKey);
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();

    const cached = await resolver("kid-1");
    expect(cached).toEqual(fakeKey);
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it("fetches again for a different kid", async () => {
    const key2 = { ...fakeKey, kid: "kid-2" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ key: fakeKey }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ key: key2 }),
        text: async () => "",
      });
    vi.stubGlobal("fetch", fetchMock);

    const resolver = createPlaidKeyResolver(opts);
    await resolver("kid-1");
    await resolver("kid-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when Plaid returns a non-OK response", async () => {
    mockFetch({ error_code: "INVALID_KEY_ID" }, false);
    const resolver = createPlaidKeyResolver(opts);

    await expect(resolver("bad-kid")).rejects.toThrow("Plaid JWKS fetch failed");
  });

  it("throws when response is missing the key field", async () => {
    mockFetch({ request_id: "abc" });
    const resolver = createPlaidKeyResolver(opts);

    await expect(resolver("kid-1")).rejects.toThrow("missing 'key' field");
  });
});
