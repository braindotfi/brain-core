import { describe, expect, it } from "vitest";
import {
  BRAIN_ERROR_CODES,
  BrainError,
  brainError,
  docsUrlFor,
  httpStatusForCode,
  isBrainError,
  isBrainErrorCode,
  toErrorEnvelope,
  type BrainErrorCode,
} from "./errors.js";

describe("BRAIN_ERROR_CODES registry", () => {
  it("contains every category enumerated in §4.3", () => {
    // Spot-check representatives from each category.
    const representatives: BrainErrorCode[] = [
      "auth_token_missing",
      "request_body_invalid",
      "raw_artifact_not_found",
      "wiki_entity_not_found",
      "policy_not_found",
      "execution_proposal_not_found",
      "audit_event_not_found",
      "dependency_unavailable",
    ];
    for (const code of representatives) {
      expect(BRAIN_ERROR_CODES).toContain(code);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(BRAIN_ERROR_CODES).size).toBe(BRAIN_ERROR_CODES.length);
  });

  it("uses snake_case {domain}_{condition} convention", () => {
    for (const code of BRAIN_ERROR_CODES) {
      expect(code).toMatch(/^[a-z]+(_[a-z0-9]+)+$/);
    }
  });
});

describe("isBrainErrorCode", () => {
  it("accepts registered codes", () => {
    expect(isBrainErrorCode("auth_token_missing")).toBe(true);
  });
  it("rejects unknown codes", () => {
    expect(isBrainErrorCode("totally_made_up")).toBe(false);
  });
});

describe("httpStatusForCode", () => {
  it("maps auth codes to 401/403", () => {
    expect(httpStatusForCode("auth_token_missing")).toBe(401);
    expect(httpStatusForCode("auth_token_expired")).toBe(401);
    expect(httpStatusForCode("auth_scope_insufficient")).toBe(403);
    expect(httpStatusForCode("auth_tenant_mismatch")).toBe(403);
  });

  it("maps not-found codes to 404", () => {
    const notFound: BrainErrorCode[] = [
      "raw_artifact_not_found",
      "raw_artifact_tombstoned",
      "wiki_entity_not_found",
      "policy_not_found",
      "execution_proposal_not_found",
      "audit_event_not_found",
    ];
    for (const code of notFound) expect(httpStatusForCode(code)).toBe(404);
  });

  it("maps dependency outages to 503", () => {
    expect(httpStatusForCode("dependency_unavailable")).toBe(503);
    expect(httpStatusForCode("execution_rail_unavailable")).toBe(503);
  });

  it("maps rate_limit_exceeded to 429", () => {
    expect(httpStatusForCode("rate_limit_exceeded")).toBe(429);
  });

  it("maps request_too_large to 413", () => {
    expect(httpStatusForCode("request_too_large")).toBe(413);
  });

  it("maps internal_server_error to 500", () => {
    expect(httpStatusForCode("internal_server_error")).toBe(500);
  });

  it("defines a status for every code in the registry", () => {
    for (const code of BRAIN_ERROR_CODES) {
      const status = httpStatusForCode(code);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

describe("docsUrlFor", () => {
  it("points at the Brain docs site", () => {
    expect(docsUrlFor("policy_rule_invalid")).toBe(
      "https://docs.brain.fi/errors/policy_rule_invalid",
    );
  });
});

describe("BrainError / brainError", () => {
  it("defaults statusCode to the registry mapping", () => {
    const err = new BrainError("auth_token_missing", "no token");
    expect(err.statusCode).toBe(401);
  });

  it("honors statusOverride when supplied", () => {
    const err = new BrainError("internal_server_error", "boom", {
      statusOverride: 502,
    });
    expect(err.statusCode).toBe(502);
  });

  it("carries details and cause", () => {
    const rootCause = new Error("underlying");
    const err = brainError("request_body_invalid", "missing field", {
      details: { field: "amount" },
      cause: rootCause,
    });
    expect(err.details).toEqual({ field: "amount" });
    expect(err.cause).toBe(rootCause);
  });

  it("isBrainError narrows correctly", () => {
    const err: unknown = new BrainError("auth_token_invalid", "bad sig");
    expect(isBrainError(err)).toBe(true);
    expect(isBrainError(new Error("other"))).toBe(false);
    expect(isBrainError("not an error")).toBe(false);
  });

  it("is a real Error and survives instanceof after transpilation", () => {
    const err = new BrainError("auth_token_invalid", "bad sig");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BrainError);
    expect(err.name).toBe("BrainError");
  });
});

describe("toErrorEnvelope", () => {
  it("wraps into the §4.1 shape", () => {
    const err = brainError("policy_rule_invalid", "bad rule", {
      details: { rule_id: "abc" },
    });
    const envelope = toErrorEnvelope(err, "req_TEST");
    expect(envelope).toEqual({
      error: {
        code: "policy_rule_invalid",
        message: "bad rule",
        details: { rule_id: "abc" },
        request_id: "req_TEST",
        docs_url: "https://docs.brain.fi/errors/policy_rule_invalid",
      },
    });
  });

  it("omits details when absent", () => {
    const err = brainError("auth_token_missing", "no header");
    const envelope = toErrorEnvelope(err, "req_XYZ");
    expect(envelope.error).not.toHaveProperty("details");
  });
});
