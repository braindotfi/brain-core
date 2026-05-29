import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetConfigForTests, loadConfig, parseConfig } from "./config.js";

const MIN_ENV = {
  DATABASE_URL: "postgres://brain:brain@localhost:5432/brain",
  REDIS_URL: "redis://localhost:6379",
  AUTH_JWKS_URL: "https://auth.brain.fi/.well-known/jwks.json",
};

afterEach(() => {
  _resetConfigForTests();
  vi.unstubAllEnvs();
});

describe("parseConfig", () => {
  it("accepts the minimal required env and fills defaults", () => {
    const cfg = parseConfig(MIN_ENV);
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.SERVICE_NAME).toBe("brain-unknown");
    expect(cfg.LOG_LEVEL).toBe("info");
    expect(cfg.DATABASE_POOL_MAX).toBe(10);
    expect(cfg.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(cfg.REQUEST_BODY_LIMIT_BYTES).toBe(52_428_800);
    expect(cfg.AUTH_ISSUER).toBe("https://auth.brain.fi");
    expect(cfg.AUTH_CLOCK_TOLERANCE_SECONDS).toBe(5);
  });

  it("rejects missing DATABASE_URL with a helpful message", () => {
    const bad = { ...MIN_ENV, DATABASE_URL: undefined };
    expect(() => parseConfig(bad)).toThrowError(/DATABASE_URL/);
  });

  it("rejects malformed URL values", () => {
    expect(() => parseConfig({ ...MIN_ENV, DATABASE_URL: "not a url" })).toThrowError(
      /DATABASE_URL/,
    );
    expect(() => parseConfig({ ...MIN_ENV, REDIS_URL: "not a url" })).toThrowError(/REDIS_URL/);
    expect(() => parseConfig({ ...MIN_ENV, AUTH_JWKS_URL: "not a url" })).toThrowError(
      /AUTH_JWKS_URL/,
    );
  });

  it("coerces numeric env vars", () => {
    const cfg = parseConfig({
      ...MIN_ENV,
      DATABASE_POOL_MAX: "42",
      IDEMPOTENCY_TTL_SECONDS: "3600",
    });
    expect(cfg.DATABASE_POOL_MAX).toBe(42);
    expect(cfg.IDEMPOTENCY_TTL_SECONDS).toBe(3600);
  });

  it("rejects non-positive numerics", () => {
    expect(() => parseConfig({ ...MIN_ENV, DATABASE_POOL_MAX: "0" })).toThrowError(
      /DATABASE_POOL_MAX/,
    );
    expect(() => parseConfig({ ...MIN_ENV, DATABASE_POOL_MAX: "-1" })).toThrowError(
      /DATABASE_POOL_MAX/,
    );
  });

  it("rejects unknown NODE_ENV values", () => {
    expect(() => parseConfig({ ...MIN_ENV, NODE_ENV: "staging-v2" })).toThrowError(/NODE_ENV/);
  });

  it("treats empty-string values for optional secrets as absent", () => {
    // Shells routinely export `ANTHROPIC_API_KEY=` (no value); that should be
    // equivalent to unset, not a parse error. Same for OPENAI_API_KEY,
    // PLAID_*, and the Key Vault secret name.
    const cfg = parseConfig({
      ...MIN_ENV,
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      PLAID_CLIENT_ID: "",
      PLAID_SECRET: "",
      BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME: "",
    });
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.OPENAI_API_KEY).toBeUndefined();
    expect(cfg.PLAID_CLIENT_ID).toBeUndefined();
    expect(cfg.PLAID_SECRET).toBeUndefined();
    expect(cfg.BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME).toBeUndefined();
  });

  it("accepts optional OTLP endpoint and omits when absent", () => {
    const with_otlp = parseConfig({
      ...MIN_ENV,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com/v1/traces",
    });
    expect(with_otlp.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://otlp.example.com/v1/traces");

    const without = parseConfig(MIN_ENV);
    expect(without.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });
});

describe("loadConfig", () => {
  it("reads from process.env and caches", () => {
    vi.stubEnv("DATABASE_URL", MIN_ENV.DATABASE_URL);
    vi.stubEnv("REDIS_URL", MIN_ENV.REDIS_URL);
    vi.stubEnv("AUTH_JWKS_URL", MIN_ENV.AUTH_JWKS_URL);

    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b); // cached
  });
});
