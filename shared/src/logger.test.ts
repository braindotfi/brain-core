import { describe, expect, it } from "vitest";
import { childFromContext, createLogger, type BrainLogContext } from "./logger.js";

/**
 * Capture pino output by writing into a stream the test owns. The default
 * pino transport writes to stdout — which would spam the test runner.
 */
import { Writable } from "node:stream";
import pino from "pino";

function makeCapturingLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString("utf8").trim());
      cb();
    },
  });
  const logger = pino(
    {
      base: { service: "brain-test" },
      timestamp: () => `,"timestamp":"2026-04-24T00:00:00.000Z"`,
      messageKey: "message",
      formatters: { level: (l) => ({ level: l }) },
    },
    stream,
  );
  return { logger, lines };
}

describe("createLogger", () => {
  it("returns a pino Logger with the service name bound", () => {
    const log = createLogger({ service: "brain-api" });
    expect(log).toBeDefined();
    expect(typeof log.info).toBe("function");
  });

  it("respects custom level", () => {
    const log = createLogger({ service: "brain-api", level: "debug" });
    expect(log.level).toBe("debug");
  });
});

describe("childFromContext", () => {
  it("attaches §6.1 required fields to every line", () => {
    const { logger, lines } = makeCapturingLogger();
    const child = childFromContext(logger, {
      tenant_id: "tnt_01HQ7K3",
      request_id: "req_01HQ7K3",
      trace_id: "trace_01HQ7K3",
    });
    child.info("hello");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.tenant_id).toBe("tnt_01HQ7K3");
    expect(parsed.request_id).toBe("req_01HQ7K3");
    expect(parsed.trace_id).toBe("trace_01HQ7K3");
    expect(parsed.service).toBe("brain-test");
    expect(parsed.message).toBe("hello");
    expect(parsed.level).toBe("info");
  });

  it("drops undefined keys to keep records lean", () => {
    const { logger, lines } = makeCapturingLogger();
    const child = childFromContext(logger, {
      tenant_id: "tnt_01HQ7K3",
      request_id: undefined,
    } as unknown as BrainLogContext);
    child.info("hello");
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.tenant_id).toBe("tnt_01HQ7K3");
    expect(parsed).not.toHaveProperty("request_id");
  });

  it("allows arbitrary additional context fields", () => {
    const { logger, lines } = makeCapturingLogger();
    const child = childFromContext(logger, {
      tenant_id: "tnt_01HQ7K3",
      principal_id: "user_01HQ7K3",
      principal_type: "user",
      custom_attr: 42,
    });
    child.info("hello");
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.principal_id).toBe("user_01HQ7K3");
    expect(parsed.principal_type).toBe("user");
    expect(parsed.custom_attr).toBe(42);
  });
});
