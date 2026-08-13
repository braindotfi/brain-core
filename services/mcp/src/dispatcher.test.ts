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
  it("treats a request with no id member as a notification (id=undefined)", () => {
    // Per JSON-RPC 2.0, a notification is a Request object with the `id`
    // member OMITTED, not present with value null. Collapsing the two used
    // to make every notification look like an ordinary id=null request.
    const r = parseRequest({ jsonrpc: "2.0", method: "ping", params: {} });
    expect(r).not.toBeNull();
    expect(r!.id).toBeUndefined();
    expect("id" in r!).toBe(false);
  });
  it("preserves an explicit null id as a real request, not a notification", () => {
    const r = parseRequest({ jsonrpc: "2.0", id: null, method: "ping", params: {} });
    expect(r).not.toBeNull();
    expect("id" in r!).toBe(true);
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
    expect(res !== null && "error" in res && res.error.code).toBe(JSON_RPC_PARSE_ERROR);
  });

  it("returns method-not-found for unknown methods", async () => {
    const res = await dispatch(
      { jsonrpc: "2.0", id: 7, method: "tools/banana" },
      { handlers: { ping: async () => ({}) } },
      ctx,
    );
    expect(res !== null && "error" in res && res.error.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    if (res !== null && "error" in res) expect(res.id).toBe(7);
  });

  it("dispatches to the registered handler and returns the result", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const res = await dispatch(
      { jsonrpc: "2.0", id: "abc", method: "ping", params: {} },
      { handlers: { ping: handler } },
      ctx,
    );
    expect(res !== null && "result" in res).toBe(true);
    if (res !== null && "result" in res) expect(res.result).toEqual({ ok: true });
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
    expect(res !== null && "error" in res && res.error.code).toBe(-32002);
    if (res !== null && "error" in res) {
      expect(res.error.message).toContain("missing scope");
      expect(res.error.data?.brain_code).toBe("auth_scope_insufficient");
    }
  });

  it("maps granular gate_* codes to the gate-failed JSON-RPC code, not internal error", async () => {
    const res = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
      {
        handlers: {
          "tools/call": async () => {
            throw { code: "gate_counterparty_sanctioned", message: "counterparty sanctioned" };
          },
        },
      },
      ctx,
    );
    expect(res !== null && "error" in res && res.error.code).toBe(-32004);
    if (res !== null && "error" in res) {
      expect(res.error.code).not.toBe(JSON_RPC_INTERNAL_ERROR);
      expect(res.error.data?.brain_code).toBe("gate_counterparty_sanctioned");
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
    expect(res !== null && "error" in res && res.error.code).toBe(JSON_RPC_INTERNAL_ERROR);
    // The uncaught exception's own message must never reach the client --
    // it could be a stack trace, a DB connection string, or other detail
    // that never went through brainError(...) at all.
    if (res !== null && "error" in res) {
      expect(res.error.message).toBe("Internal error");
      expect(res.error.message).not.toContain("boom");
    }
  });

  describe("not-found family error mapping (BRAIN-103)", () => {
    it.each([
      "execution_proposal_not_found",
      "raw_artifact_not_found",
      "payment_intent_not_found",
      "payment_intent_invalid_state",
      "proof_not_found",
      "ledger_row_not_found",
      "wiki_page_not_found",
      "payment_intent_approval_invalid",
    ])("maps %s to -32602 and preserves the message", async (code) => {
      const res = await dispatch(
        { jsonrpc: "2.0", id: 1, method: "tools/call" },
        {
          handlers: {
            "tools/call": async () => {
              throw { code, message: `no such thing: ${code}` };
            },
          },
        },
        ctx,
      );
      expect(res !== null && "error" in res && res.error.code).toBe(-32602);
      if (res !== null && "error" in res) {
        expect(res.error.message).toBe(`no such thing: ${code}`);
        expect(res.error.data?.brain_code).toBe(code);
      }
    });

    it("preserves the message for dependency_unavailable despite staying at the internal-error code", async () => {
      const res = await dispatch(
        { jsonrpc: "2.0", id: 1, method: "tools/call" },
        {
          handlers: {
            "tools/call": async () => {
              throw {
                code: "dependency_unavailable",
                message: "agent.action.propose is not available",
              };
            },
          },
        },
        ctx,
      );
      expect(res !== null && "error" in res && res.error.code).toBe(JSON_RPC_INTERNAL_ERROR);
      if (res !== null && "error" in res) {
        expect(res.error.message).toBe("agent.action.propose is not available");
      }
    });
  });

  describe("notifications (no id) get no response", () => {
    it("returns null for a notification dispatched to a known handler", async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      const res = await dispatch(
        { jsonrpc: "2.0", method: "ping", params: {} },
        { handlers: { ping: handler } },
        ctx,
      );
      expect(res).toBeNull();
      expect(handler).toHaveBeenCalledOnce();
    });

    it("returns null for a notification to an unknown method (no method-not-found body)", async () => {
      const res = await dispatch(
        { jsonrpc: "2.0", method: "tools/banana" },
        { handlers: { ping: async () => ({}) } },
        ctx,
      );
      expect(res).toBeNull();
    });

    it("returns null for a notification whose handler throws", async () => {
      const res = await dispatch(
        { jsonrpc: "2.0", method: "tools/call" },
        {
          handlers: {
            "tools/call": async () => {
              throw { code: "auth_scope_insufficient", message: "missing scope" };
            },
          },
        },
        ctx,
      );
      expect(res).toBeNull();
    });

    it("still returns a normal response for an id-bearing request to the same handler", async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      const res = await dispatch(
        { jsonrpc: "2.0", id: 42, method: "ping", params: {} },
        { handlers: { ping: handler } },
        ctx,
      );
      expect(res).not.toBeNull();
      expect(res !== null && "result" in res).toBe(true);
      if (res !== null && "result" in res) {
        expect(res.id).toBe(42);
        expect(res.result).toEqual({ ok: true });
      }
    });
  });
});
