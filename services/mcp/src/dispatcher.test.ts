import { describe, expect, it, vi } from "vitest";
import { dispatch, invalidParams, parseRequest } from "./dispatcher.js";
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
} from "./types.js";

describe("parseRequest", () => {
  it("accepts a well-formed JSON-RPC 2.0 request", () => {
    const r = parseRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(r).not.toBeNull();
    expect(r!.method).toBe("tools/list");
    expect(r!.id).toBe(1);
  });
  it("rejects missing jsonrpc version", () => {
    expect(parseRequest({ id: 1, method: "x" })).toBeNull();
  });
  it("rejects missing method", () => {
    expect(parseRequest({ jsonrpc: "2.0", id: 1 })).toBeNull();
  });
  it("rejects array payloads (no batch in v0.3)", () => {
    expect(parseRequest([])).toBeNull();
  });
  it("normalizes missing params to {}", () => {
    const r = parseRequest({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(r!.params).toEqual({});
  });
  it("treats missing id as notification (id=null)", () => {
    const r = parseRequest({ jsonrpc: "2.0", method: "ping", params: {} });
    expect(r).not.toBeNull();
    expect(r!.id).toBeNull();
  });
  it("normalizes invalid id type to null", () => {
    const r = parseRequest({ jsonrpc: "2.0", id: { nested: true }, method: "ping" });
    expect(r).not.toBeNull();
    expect(r!.id).toBeNull();
  });
});

describe("invalidParams", () => {
  it("throws with code request_params_invalid", () => {
    expect(() => invalidParams("bad input")).toThrow();
    try {
      invalidParams("bad input");
    } catch (e) {
      expect((e as { code: string }).code).toBe("request_params_invalid");
    }
  });
  it("attaches details when provided", () => {
    try {
      invalidParams("bad input", { field: "x" });
    } catch (e) {
      expect((e as { details: unknown }).details).toEqual({ field: "x" });
    }
  });
});

describe("dispatch", () => {
  const ctx = { requestId: "req_test" };

  it("returns parse error on malformed payload", async () => {
    const res = await dispatch("not an object", { handlers: {} }, ctx);
    expect("error" in res && res.error.code).toBe(JSON_RPC_PARSE_ERROR);
  });

  it("returns method-not-found for unknown methods", async () => {
    const res = await dispatch(
      { jsonrpc: "2.0", id: 7, method: "tools/banana" },
      { handlers: { ping: async () => ({}) } },
      ctx,
    );
    expect("error" in res && res.error.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    if ("error" in res) expect(res.id).toBe(7);
  });

  it("dispatches to the registered handler and returns the result", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const res = await dispatch(
      { jsonrpc: "2.0", id: "abc", method: "ping", params: {} },
      { handlers: { ping: handler } },
      ctx,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) expect(res.result).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("maps a Brain-shaped error to the right JSON-RPC code", async () => {
    const res = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
      {
        handlers: {
          "tools/call": async () => {
            throw {
              code: "auth_scope_insufficient",
              message: "missing scope",
              details: { required: ["payment_intent:propose"] },
            };
          },
        },
      },
      ctx,
    );
    expect("error" in res && res.error.code).toBe(-32002);
    if ("error" in res) {
      expect(res.error.message).toContain("missing scope");
      expect(res.error.data?.brain_code).toBe("auth_scope_insufficient");
    }
  });

  it("falls back to internal error for unknown errors", async () => {
    const res = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        handlers: {
          ping: async () => {
            throw new Error("boom");
          },
        },
      },
      ctx,
    );
    expect("error" in res && res.error.code).toBe(JSON_RPC_INTERNAL_ERROR);
  });
});
