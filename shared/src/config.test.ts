import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetConfigForTests,
  assertProductionInfraSecretsSafe,
  loadConfig,
  parseConfig,
} from "./config.js";

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
    expect(cfg.BRAIN_TRUST_GATE_ENABLED).toBe(false);
    expect(cfg.BRAIN_COMMERCIAL_CATALOG_ENABLED).toBe(false);
    expect(cfg.BRAIN_COMMERCIAL_SHADOW_ENABLED).toBe(false);
    expect(cfg.BRAIN_ENTITY_SCOPE_ENABLED).toBe(false);
    expect(cfg.BRAIN_AGENT_CAPACITY_ENABLED).toBe(false);
    expect(cfg.BRAIN_EXECUTION_LIMITS_ENABLED).toBe(false);
    expect(cfg.BRAIN_STRIPE_BILLING_ENABLED).toBe(false);
    expect(cfg.BRAIN_X402_PAYMENTS_ENABLED).toBe(false);
    expect(cfg.BRAIN_OUTCOME_FEES_ENABLED).toBe(false);
    expect(cfg.BRAIN_MOVEMENT_FEES_ENABLED).toBe(false);
  });

  it("parses each commercial gate independently without provider credentials", () => {
    const cfg = parseConfig({
      ...MIN_ENV,
      BRAIN_COMMERCIAL_CATALOG_ENABLED: "true",
      BRAIN_COMMERCIAL_SHADOW_ENABLED: "true",
      BRAIN_ENTITY_SCOPE_ENABLED: "true",
      BRAIN_AGENT_CAPACITY_ENABLED: "true",
      BRAIN_EXECUTION_LIMITS_ENABLED: "true",
      BRAIN_STRIPE_BILLING_ENABLED: "true",
      BRAIN_X402_PAYMENTS_ENABLED: "true",
      BRAIN_OUTCOME_FEES_ENABLED: "true",
      BRAIN_MOVEMENT_FEES_ENABLED: "true",
    });
    expect(cfg.BRAIN_COMMERCIAL_CATALOG_ENABLED).toBe(true);
    expect(cfg.BRAIN_COMMERCIAL_SHADOW_ENABLED).toBe(true);
    expect(cfg.BRAIN_ENTITY_SCOPE_ENABLED).toBe(true);
    expect(cfg.BRAIN_AGENT_CAPACITY_ENABLED).toBe(true);
    expect(cfg.BRAIN_EXECUTION_LIMITS_ENABLED).toBe(true);
    expect(cfg.BRAIN_STRIPE_BILLING_ENABLED).toBe(true);
    expect(cfg.BRAIN_X402_PAYMENTS_ENABLED).toBe(true);
    expect(cfg.BRAIN_OUTCOME_FEES_ENABLED).toBe(true);
    expect(cfg.BRAIN_MOVEMENT_FEES_ENABLED).toBe(true);
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

describe("assertProductionInfraSecretsSafe", () => {
  const strongProductionEnv = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://brain_app:strong-app-pass@localhost:5432/brain",
    BRAIN_RAW_WORKER_DB_URL: "postgres://brain_raw_worker:strong-raw-pass@localhost:5432/brain",
    S3_ACCESS_KEY_ID: "brain-prod-minio",
    S3_SECRET_ACCESS_KEY: "strong-minio-secret",
  };

  it("throws in production when a database URL password is empty", () => {
    expect(() =>
      assertProductionInfraSecretsSafe({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://brain_app:@localhost:5432/brain",
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it("throws in production when a database URL password uses a role-name default", () => {
    expect(() =>
      assertProductionInfraSecretsSafe({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://brain_app:brain_app@localhost:5432/brain",
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it("throws in production when a raw DB password env var uses a generic weak value", () => {
    expect(() =>
      assertProductionInfraSecretsSafe({
        ...strongProductionEnv,
        BRAIN_LEDGER_PROJECTOR_DB_PASSWORD: "password",
      }),
    ).toThrow(/BRAIN_LEDGER_PROJECTOR_DB_PASSWORD/);
  });

  it("passes in production with strong database and infra secrets", () => {
    expect(() => assertProductionInfraSecretsSafe(strongProductionEnv)).not.toThrow();
  });

  it("warns but does not throw in staging and lists the offending vars", () => {
    const warn = vi.fn();
    expect(() =>
      assertProductionInfraSecretsSafe(
        {
          NODE_ENV: "staging",
          DATABASE_URL: "postgres://brain_app:brain_app@localhost:5432/brain",
          MINIO_ROOT_PASSWORD: "brainminio",
        },
        { warn },
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("DATABASE_URL");
    expect(warn.mock.calls[0]?.[0]).toContain("MINIO_ROOT_PASSWORD");
  });

  it("does not enforce weak production secrets outside staging or production", () => {
    expect(() => assertProductionInfraSecretsSafe(MIN_ENV)).not.toThrow();
    expect(() => assertProductionInfraSecretsSafe({ ...MIN_ENV, NODE_ENV: "test" })).not.toThrow();
  });

  it("is enforced by parseConfig during production boot", () => {
    expect(() =>
      parseConfig({ ...MIN_ENV, NODE_ENV: "production", DATABASE_URL: MIN_ENV.DATABASE_URL }),
    ).toThrow(/DATABASE_URL password/);

    const warn = vi.fn();
    const cfg = parseConfig(
      { ...MIN_ENV, NODE_ENV: "staging", DATABASE_URL: MIN_ENV.DATABASE_URL },
      { warn },
    );
    expect(cfg.NODE_ENV).toBe("staging");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL password"));
  });
});
