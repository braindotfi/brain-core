import { describe, it, expect, vi, afterEach } from "vitest";

// Mock OTEL SDK before importing instrumentation — avoids loading the real
// exporter / provider in the test process.
const mockRegister = vi.fn();
const mockAddSpanProcessor = vi.fn();
const mockShutdown = vi.fn().mockResolvedValue(undefined);
const mockProviderInstance = {
  addSpanProcessor: mockAddSpanProcessor,
  register: mockRegister,
  shutdown: mockShutdown,
};
const MockNodeTracerProvider = vi.fn(function () {
  return mockProviderInstance;
});

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: MockNodeTracerProvider,
}));
vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: vi.fn(function () {
    return {};
  }),
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: vi.fn(function () {
    return {};
  }),
}));
vi.mock("@opentelemetry/resources", () => ({
  Resource: vi.fn(function () {
    return {};
  }),
}));
vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
  ATTR_SERVICE_VERSION: "service.version",
}));
const mockDisable = vi.fn();
vi.mock("@opentelemetry/api", () => ({
  trace: { disable: mockDisable },
}));

const { initTracing, shutdownTracing } = await import("./instrumentation.js");

// Reset provider state + mock call counts after every test so tests are
// independent of execution order.
afterEach(async () => {
  await shutdownTracing();
  vi.clearAllMocks();
});

describe("initTracing", () => {
  it("is a no-op when otlpEndpoint is undefined", () => {
    initTracing({ otlpEndpoint: undefined, serviceName: "brain-api", serviceVersion: "1.0.0" });
    expect(MockNodeTracerProvider).not.toHaveBeenCalled();
  });

  it("creates and registers a provider when otlpEndpoint is set", () => {
    initTracing({
      otlpEndpoint: "http://otel.internal:4318",
      serviceName: "brain-api",
      serviceVersion: "1.0.0",
    });
    expect(MockNodeTracerProvider).toHaveBeenCalledOnce();
    expect(mockAddSpanProcessor).toHaveBeenCalledOnce();
    expect(mockRegister).toHaveBeenCalledOnce();
  });
});

describe("shutdownTracing", () => {
  it("is a no-op when no provider has been initialised", async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it("calls provider.shutdown and disables trace API when provider exists", async () => {
    initTracing({
      otlpEndpoint: "http://otel.internal:4318",
      serviceName: "brain-api",
      serviceVersion: "1.0.0",
    });
    await shutdownTracing();
    expect(mockShutdown).toHaveBeenCalledOnce();
    expect(mockDisable).toHaveBeenCalledOnce();
  });

  it("is idempotent — second call is a no-op after provider shutdown", async () => {
    initTracing({
      otlpEndpoint: "http://otel.internal:4318",
      serviceName: "brain-api",
      serviceVersion: "1.0.0",
    });
    await shutdownTracing();
    vi.clearAllMocks();
    await shutdownTracing();
    expect(mockShutdown).not.toHaveBeenCalled();
  });
});
