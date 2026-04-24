import { SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { getTracer, llmSpan, recordError, withSpan } from "./tracing.js";

/**
 * Build a fake tracer whose spans record attribute/status/exception calls.
 * Avoids pulling in the full OTel SDK for unit tests.
 */
function makeFakeTracer(): { tracer: Tracer; spans: FakeSpan[] } {
  const spans: FakeSpan[] = [];
  const tracer: Tracer = {
    startSpan: (name) => new FakeSpan(name, spans) as unknown as Span,
    startActiveSpan: ((
      name: string,
      _optsOrFn: unknown,
      maybeFn?: (span: Span) => unknown,
    ) => {
      const span = new FakeSpan(name, spans);
      const fn = (typeof _optsOrFn === "function"
        ? _optsOrFn
        : maybeFn) as (s: Span) => unknown;
      return fn(span as unknown as Span);
    }) as Tracer["startActiveSpan"],
  };
  return { tracer, spans };
}

class FakeSpan {
  public readonly attributes: Record<string, unknown> = {};
  public status: { code: SpanStatusCode; message?: string } | null = null;
  public exceptions: unknown[] = [];
  public ended = false;
  public constructor(
    public readonly name: string,
    private readonly sink: FakeSpan[],
  ) {
    sink.push(this);
  }
  public setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }
  public setAttributes(attrs: Record<string, unknown>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }
  public setStatus(status: { code: SpanStatusCode; message?: string }): this {
    this.status = status;
    return this;
  }
  public recordException(err: unknown): this {
    this.exceptions.push(err);
    return this;
  }
  public end(): void {
    this.ended = true;
  }
  public spanContext(): { traceId: string; spanId: string; traceFlags: number } {
    return { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
  }
  public isRecording(): boolean {
    return !this.ended;
  }
  public updateName(): this {
    return this;
  }
  public addEvent(): this {
    return this;
  }
}

describe("getTracer", () => {
  it("returns a Tracer from the global OTel provider", () => {
    const tracer = getTracer("brain-test");
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe("function");
  });
});

describe("withSpan", () => {
  it("runs fn, marks OK, and ends", async () => {
    const { tracer, spans } = makeFakeTracer();
    const result = await withSpan(tracer, "raw.ingest", (span) => {
      span.setAttribute("foo", "bar");
      return 42;
    });
    expect(result).toBe(42);
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.name).toBe("raw.ingest");
    expect(s.attributes.foo).toBe("bar");
    expect(s.status?.code).toBe(SpanStatusCode.OK);
    expect(s.ended).toBe(true);
  });

  it("applies initial attributes", async () => {
    const { tracer, spans } = makeFakeTracer();
    await withSpan(tracer, "op", async () => {}, { x: 1, y: "z" });
    expect(spans[0]!.attributes).toMatchObject({ x: 1, y: "z" });
  });

  it("records error status and exception on throw, then re-raises", async () => {
    const { tracer, spans } = makeFakeTracer();
    const boom = new Error("boom");
    await expect(
      withSpan(tracer, "op", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const s = spans[0]!;
    expect(s.status?.code).toBe(SpanStatusCode.ERROR);
    expect(s.exceptions).toEqual([boom]);
    expect(s.ended).toBe(true);
  });
});

describe("llmSpan", () => {
  it("sets vendor/model/usage attributes from the result", async () => {
    const { tracer, spans } = makeFakeTracer();
    const result = await llmSpan(
      tracer,
      { model: "claude-opus-4-7", operation: "wiki.question" },
      async () => ({ result: "answer", tokens: { input: 100, output: 50 } }),
    );
    expect(result).toBe("answer");
    const s = spans[0]!;
    expect(s.name).toBe("wiki.question");
    expect(s.attributes["llm.vendor"]).toBe("anthropic");
    expect(s.attributes["llm.request.model"]).toBe("claude-opus-4-7");
    expect(s.attributes["llm.usage.prompt_tokens"]).toBe(100);
    expect(s.attributes["llm.usage.completion_tokens"]).toBe(50);
    expect(s.attributes["llm.usage.total_tokens"]).toBe(150);
  });

  it("recognizes openai models", async () => {
    const { tracer, spans } = makeFakeTracer();
    await llmSpan(
      tracer,
      { model: "gpt-4o-mini", operation: "wiki.embedding" },
      async () => ({ result: null }),
    );
    expect(spans[0]!.attributes["llm.vendor"]).toBe("openai");
  });

  it("labels unknown models as 'unknown'", async () => {
    const { tracer, spans } = makeFakeTracer();
    await llmSpan(
      tracer,
      { model: "mystery-xyz", operation: "op" },
      async () => ({ result: null }),
    );
    expect(spans[0]!.attributes["llm.vendor"]).toBe("unknown");
  });

  it("skips usage attributes when tokens not reported", async () => {
    const { tracer, spans } = makeFakeTracer();
    await llmSpan(tracer, { model: "claude-opus-4-7", operation: "op" }, async () => ({
      result: null,
    }));
    expect(spans[0]!.attributes["llm.usage.total_tokens"]).toBeUndefined();
  });
});

describe("recordError", () => {
  it("sets ERROR status and records exception for Error", () => {
    const { tracer, spans } = makeFakeTracer();
    tracer.startActiveSpan("op", (span) => {
      recordError(span, new Error("fail"));
      span.end();
    });
    const s = spans[0]!;
    expect(s.status?.code).toBe(SpanStatusCode.ERROR);
    expect(s.status?.message).toBe("fail");
    expect(s.exceptions).toHaveLength(1);
  });

  it("coerces non-Error values to a string message", () => {
    const { tracer, spans } = makeFakeTracer();
    tracer.startActiveSpan("op", (span) => {
      recordError(span, "weird");
      span.end();
    });
    expect(spans[0]!.status?.message).toBe("weird");
    expect(spans[0]!.exceptions).toHaveLength(0);
  });
});

describe("currentTraceId", () => {
  it("returns undefined when no active span exists", async () => {
    // Default no-op tracer provider has no active span.
    const { currentTraceId } = await import("./tracing.js");
    expect(currentTraceId()).toBeUndefined();
  });

  it("returns the trace id when an active span is present", async () => {
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "aabbccddeeff00112233445566778899",
        spanId: "1122334455667788",
        traceFlags: 1,
      }),
    } as unknown as Span);
    const { currentTraceId } = await import("./tracing.js");
    expect(currentTraceId()).toBe("aabbccddeeff00112233445566778899");
    spy.mockRestore();
  });

  it("rejects all-zero trace ids as invalid", async () => {
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        traceFlags: 0,
      }),
    } as unknown as Span);
    const { currentTraceId } = await import("./tracing.js");
    expect(currentTraceId()).toBeUndefined();
    spy.mockRestore();
  });
});
