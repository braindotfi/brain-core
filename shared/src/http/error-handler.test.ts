import { describe, expect, it } from "vitest";
import { brainError } from "../errors.js";
import { _forTests } from "./error-handler.js";

const { mapError } = _forTests;

describe("mapError", () => {
  it("returns BrainError unchanged", () => {
    const original = brainError("wiki_entity_not_found", "gone");
    expect(mapError(original)).toBe(original);
  });

  it("maps Fastify body-validation errors to request_body_invalid", () => {
    const mapped = mapError({
      validation: [{ keyword: "required", params: { missingProperty: "amount" } }],
      validationContext: "body",
      message: "body: must have required property 'amount'",
    });
    expect(mapped.code).toBe("request_body_invalid");
    expect(mapped.statusCode).toBe(400);
    expect(mapped.details).toMatchObject({ validation: expect.any(Array) });
  });

  it("maps Fastify params-validation errors to request_params_invalid", () => {
    const mapped = mapError({
      validation: [{ keyword: "type", params: {} }],
      validationContext: "params",
      message: "params: must be string",
    });
    expect(mapped.code).toBe("request_params_invalid");
  });

  it("maps 413 to request_too_large", () => {
    const mapped = mapError({ statusCode: 413, message: "too big" });
    expect(mapped.code).toBe("request_too_large");
    expect(mapped.statusCode).toBe(413);
  });

  it("maps 429 to rate_limit_exceeded", () => {
    const mapped = mapError({ statusCode: 429, message: "slow down" });
    expect(mapped.code).toBe("rate_limit_exceeded");
    expect(mapped.statusCode).toBe(429);
  });

  it("maps a generic 404 (unmatched route) to route_not_found, not a domain code", () => {
    const mapped = mapError({ statusCode: 404, message: "not found" });
    expect(mapped.code).toBe("route_not_found");
    expect(mapped.statusCode).toBe(404);
  });

  it("collapses unknown errors into internal_server_error without leaking the message", () => {
    const underlying = new Error("database connection failed: creds=xxxxx");
    const mapped = mapError(underlying);
    expect(mapped.code).toBe("internal_server_error");
    expect(mapped.message).toBe("internal server error");
    expect(mapped.cause).toBe(underlying);
  });
});
