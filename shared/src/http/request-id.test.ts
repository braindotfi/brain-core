import { Writable } from "node:stream";
import Fastify from "fastify";
import pino from "pino";
import { describe, expect, it } from "vitest";
import requestIdPlugin, { sanitizeRequestId } from "./request-id.js";

describe("sanitizeRequestId", () => {
  it("accepts well-formed client-supplied IDs", () => {
    expect(sanitizeRequestId("req_01HQ7K3ABCDEFGHJKMNPQRSTV")).toBe(
      "req_01HQ7K3ABCDEFGHJKMNPQRSTV",
    );
    expect(sanitizeRequestId("support-ticket-1234")).toBe("support-ticket-1234");
  });

  it("rejects non-string values", () => {
    expect(sanitizeRequestId(undefined)).toBeNull();
    expect(sanitizeRequestId(42)).toBeNull();
    expect(sanitizeRequestId(["a", "b"])).toBeNull();
  });

  it("rejects empty and oversized strings", () => {
    expect(sanitizeRequestId("")).toBeNull();
    expect(sanitizeRequestId("x".repeat(129))).toBeNull();
  });

  it("rejects disallowed characters", () => {
    expect(sanitizeRequestId("req id with spaces")).toBeNull();
    expect(sanitizeRequestId("<script>")).toBeNull();
    expect(sanitizeRequestId("req\n01")).toBeNull();
  });

  it("permits the characters in Brain ID shapes", () => {
    expect(sanitizeRequestId("req_01HQ7K3.ABC:DEF-123")).toBe("req_01HQ7K3.ABC:DEF-123");
  });

  it("binds the Brain request id to subsequent Fastify log records", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString("utf8").trim());
        callback();
      },
    });
    const app = Fastify({ loggerInstance: pino({}, stream) });
    await app.register(requestIdPlugin);
    app.get("/probe", async (request) => {
      request.log.warn("request-id correlation probe");
      return { ok: true };
    });

    const requestId = "req_01HQ7K3ABCDEFGHJKMNPQRSTV";
    const response = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-request-id": requestId },
    });
    await app.close();

    expect(response.headers["x-request-id"]).toBe(requestId);
    const record = lines
      .map((line) => JSON.parse(line) as { msg?: string; request_id?: string })
      .find((line) => line.msg === "request-id correlation probe");
    expect(record?.request_id).toBe(requestId);
  });
});
