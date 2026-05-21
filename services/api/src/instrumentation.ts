/**
 * OpenTelemetry SDK initialisation for brain-server.
 *
 * Must be called before Fastify and any service imports so auto-instrumentation
 * patches are applied first. Call once at the top of main().
 *
 * When OTEL_EXPORTER_OTLP_ENDPOINT is absent the function is a no-op,
 * preserving the dev experience without a collector.
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { trace } from "@opentelemetry/api";

let provider: NodeTracerProvider | undefined;

export function initTracing(opts: {
  otlpEndpoint: string | undefined;
  serviceName: string;
  serviceVersion: string;
}): void {
  if (opts.otlpEndpoint === undefined) return;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion,
  });

  provider = new NodeTracerProvider({ resource });
  provider.addSpanProcessor(
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${opts.otlpEndpoint}/v1/traces` }),
    ),
  );
  provider.register();
}

export async function shutdownTracing(): Promise<void> {
  if (provider === undefined) return;
  try {
    await provider.shutdown();
  } finally {
    trace.disable();
    provider = undefined;
  }
}
