/**
 * Brain distributed tracing.
 *
 * §6.3: OpenTelemetry across all services. Every request gets a trace_id.
 * Cross-service calls propagate the context. Spans named `{service}.{operation}`.
 * LLM calls are their own spans with `model` and token counts as attributes.
 *
 * This module is deliberately minimal:
 *   - `getTracer(serviceName)` — a named tracer for a service.
 *   - `withSpan(tracer, name, fn, attrs?)` — wrap a function in a span,
 *     propagate exceptions, record errors, end the span.
 *   - `llmSpan(tracer, opts, fn)` — standardized LLM call span with model
 *     and token accounting.
 *
 * SDK configuration (exporter selection, auto-instrumentation wiring) lives
 * in stage-8 under `services/*\/instrumentation.ts`. At the API level, we
 * only depend on `@opentelemetry/api` so test code doesn't pay the SDK cost.
 */

import { SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";

/** Get a named tracer for a service. Cheap — safe to call repeatedly. */
export function getTracer(serviceName: string, version: string = "0.0.0-dev"): Tracer {
  return trace.getTracer(serviceName, version);
}

/** Extract the active trace id for injection into log context. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (span === undefined) return undefined;
  const ctx = span.spanContext();
  // A span with a zeroed trace id is invalid (off-context). Don't propagate.
  return ctx.traceId === "00000000000000000000000000000000" ? undefined : ctx.traceId;
}

/**
 * Wrap a function in a span. On throw, records the error and re-raises.
 *
 *     await withSpan(tracer, "raw.ingest", async (span) => { ... })
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => T | Promise<T>,
  attrs?: Attributes,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attrs !== undefined) span.setAttributes(attrs);
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      recordError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface LlmSpanOptions {
  /** Anthropic / OpenAI / whatever. Becomes the `model` attribute. */
  model: string;
  /** The purpose of the call — `wiki.question`, `agent.payment.reason`, etc. */
  operation: string;
  /** Optional extra attributes to set before the call. */
  attributes?: Attributes;
}

export interface LlmSpanResult<T> {
  result: T;
  /** Token accounting reported back for cost aggregation. */
  tokens?: { input: number; output: number };
}

/**
 * Standardized LLM call span. Sets `llm.*` attributes per OTel semantic
 * conventions so Datadog / DD LLM Obs shows them consistently.
 *
 * The caller returns `{ result, tokens }` from `fn`; this helper sets token
 * attributes on the span automatically.
 */
export async function llmSpan<T>(
  tracer: Tracer,
  opts: LlmSpanOptions,
  fn: (span: Span) => Promise<LlmSpanResult<T>>,
): Promise<T> {
  return withSpan(
    tracer,
    opts.operation,
    async (span) => {
      span.setAttribute("llm.vendor", vendorForModel(opts.model));
      span.setAttribute("llm.request.model", opts.model);
      if (opts.attributes !== undefined) span.setAttributes(opts.attributes);

      const out = await fn(span);
      if (out.tokens !== undefined) {
        span.setAttribute("llm.usage.prompt_tokens", out.tokens.input);
        span.setAttribute("llm.usage.completion_tokens", out.tokens.output);
        span.setAttribute(
          "llm.usage.total_tokens",
          out.tokens.input + out.tokens.output,
        );
      }
      return out.result;
    },
    { "llm.operation": opts.operation },
  );
}

export function recordError(span: Span, err: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
  if (err instanceof Error) span.recordException(err);
}

function vendorForModel(model: string): string {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o")) return "openai";
  if (model.startsWith("text-embedding-")) return "openai";
  return "unknown";
}
