import { describe, expect, it, vi } from "vitest";
import { BRAIN_BASE_URLS, Brain, resolveBaseUrl, type BrainOptions } from "./index.js";

const goodKey = "brain_sk_test_abc123def456";

describe("BRAIN_BASE_URLS", () => {
  it("publishes a base URL for each named environment", () => {
    expect(BRAIN_BASE_URLS.production).toBe("https://api.brain.fi/v1");
    expect(BRAIN_BASE_URLS.sandbox).toBe("https://api.brain.dev/v1");
  });
});

describe("resolveBaseUrl", () => {
  it("defaults to production when environment is unset", () => {
    expect(resolveBaseUrl({ apiKey: goodKey })).toBe("https://api.brain.fi/v1");
  });

  it("honors environment=sandbox", () => {
    expect(resolveBaseUrl({ apiKey: goodKey, environment: "sandbox" })).toBe(
      "https://api.brain.dev/v1",
    );
  });

  it("explicit baseUrl overrides environment", () => {
    const opts: BrainOptions = {
      apiKey: goodKey,
      environment: "sandbox",
      baseUrl: "http://localhost:3000/v1",
    };
    expect(resolveBaseUrl(opts)).toBe("http://localhost:3000/v1");
  });
});

describe("Brain", () => {
  it("constructs with a minimum-valid options bag", () => {
    const brain = new Brain({ apiKey: goodKey });
    expect(brain).toBeInstanceOf(Brain);
    expect(brain.baseUrl).toBe("https://api.brain.fi/v1");
    expect(brain.defaultTenantId).toBeUndefined();
  });

  it("strips trailing slashes from baseUrl", () => {
    const brain = new Brain({
      apiKey: goodKey,
      baseUrl: "https://api.brain.fi/v1/",
    });
    expect(brain.baseUrl).toBe("https://api.brain.fi/v1");
  });

  it("rejects empty apiKey with a docs-pointing error", () => {
    expect(() => new Brain({ apiKey: "" })).toThrowError(/apiKey/);
  });

  it("rejects non-string apiKey", () => {
    // @ts-expect-error — intentionally violating types to test runtime guard
    expect(() => new Brain({ apiKey: 123 })).toThrowError(/apiKey/);
  });

  it("masks the api key when requested", () => {
    const brain = new Brain({ apiKey: goodKey });
    expect(brain.getMaskedApiKey()).toBe("brain_sk_te***");
    expect(brain.getMaskedApiKey()).not.toContain(goodKey);
  });

  it("returns *** for very short keys", () => {
    const brain = new Brain({ apiKey: "short" });
    expect(brain.getMaskedApiKey()).toBe("***");
  });

  it("persists defaultTenantId", () => {
    const brain = new Brain({ apiKey: goodKey, defaultTenantId: "acme" });
    expect(brain.defaultTenantId).toBe("acme");
  });

  it("uses globalThis.fetch by default", () => {
    const brain = new Brain({ apiKey: goodKey });
    expect(brain.getFetch()).toBeTypeOf("function");
  });

  it("accepts a custom fetch implementation", async () => {
    const fakeFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const brain = new Brain({ apiKey: goodKey, fetch: fakeFetch });
    expect(brain.getFetch()).toBe(fakeFetch);
  });

  it("throws when no fetch is available", () => {
    const originalFetch = globalThis.fetch;
    // simulate a runtime without a global fetch
    Object.defineProperty(globalThis, "fetch", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(() => new Brain({ apiKey: goodKey })).toThrowError(/fetch/i);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        value: originalFetch,
        configurable: true,
      });
    }
  });
});
