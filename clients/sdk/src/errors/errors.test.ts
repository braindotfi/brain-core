import { describe, expect, it } from "vitest";
import {
  ActionAlreadyExecutedError,
  AuthInvalidKeyError,
  BRAIN_ERROR_CLASS_BY_CODE,
  BRAIN_ERROR_CODES,
  BrainError,
  GateBalanceInsufficientError,
  PolicyDeniedError,
  TenantNotFoundError,
  brainErrorFromEnvelope,
  isBrainError,
  isBrainErrorCode,
  isBrainErrorEnvelope,
  type BrainErrorCode,
  type BrainErrorEnvelope,
} from "./index.js";

describe("BRAIN_ERROR_CODES registry", () => {
  it("contains every v0.3 docs category representative", () => {
    const docsReps: BrainErrorCode[] = [
      "auth_invalid_key",
      "tenant_not_found",
      "source_rate_limit",
      "policy_denied",
      "agent_inactive",
      "action_not_found",
      "insufficient_balance",
      "gate_counterparty_sanctioned",
      "validation_failed",
      "upstream_timeout",
    ];
    for (const code of docsReps) expect(BRAIN_ERROR_CODES).toContain(code);
  });

  it("retains the v0.1/v0.2 legacy codes", () => {
    const legacyReps: BrainErrorCode[] = [
      "auth_token_missing",
      "execution_proposal_not_found",
      "wiki_question_timeout",
      "internal_server_error",
    ];
    for (const code of legacyReps) expect(BRAIN_ERROR_CODES).toContain(code);
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
    expect(isBrainErrorCode("policy_denied")).toBe(true);
    expect(isBrainErrorCode("gate_balance_insufficient")).toBe(true);
  });
  it("rejects unknown codes", () => {
    expect(isBrainErrorCode("totally_made_up")).toBe(false);
  });
});

describe("BrainError subclasses", () => {
  it("PolicyDeniedError sets code automatically", () => {
    const err = new PolicyDeniedError("rule did not match", {
      details: { rule_id: "r-001" },
    });
    expect(err.code).toBe("policy_denied");
    expect(err.message).toBe("rule did not match");
    expect(err.details).toEqual({ rule_id: "r-001" });
  });

  it("subclasses survive instanceof against BrainError", () => {
    const err = new TenantNotFoundError("missing");
    expect(err).toBeInstanceOf(BrainError);
    expect(err).toBeInstanceOf(TenantNotFoundError);
    expect(err).toBeInstanceOf(Error);
  });

  it("subclasses do not match each other", () => {
    const err = new PolicyDeniedError("nope");
    expect(err).not.toBeInstanceOf(AuthInvalidKeyError);
    expect(err).not.toBeInstanceOf(ActionAlreadyExecutedError);
  });

  it("docsUrl defaults to https://docs.brain.fi/errors/{code}", () => {
    const err = new GateBalanceInsufficientError("insufficient");
    expect(err.docsUrl).toBe(
      "https://docs.brain.fi/errors/gate_balance_insufficient",
    );
  });

  it("docsUrl honours explicit override", () => {
    const err = new BrainError("policy_denied", "x", {
      docsUrl: "https://custom.example.com/policy_denied",
    });
    expect(err.docsUrl).toBe("https://custom.example.com/policy_denied");
  });

  it("traceId, statusCode, and cause are preserved", () => {
    const root = new Error("upstream");
    const err = new BrainError("internal_error", "boom", {
      traceId: "trc_abc",
      statusCode: 500,
      cause: root,
    });
    expect(err.traceId).toBe("trc_abc");
    expect(err.statusCode).toBe(500);
    expect(err.cause).toBe(root);
  });

  it("BRAIN_ERROR_CLASS_BY_CODE maps every v0.3 docs code", () => {
    // 37 v0.3 docs codes (4 auth + 3 tenant + 3 source + 3 policy
    // + 4 agent + 5 action + 8 gate + 3 validation + 4 infra). The
    // legacy codes deliberately don't have typed subclasses.
    expect(Object.keys(BRAIN_ERROR_CLASS_BY_CODE)).toHaveLength(37);
  });
});

describe("isBrainError", () => {
  it("narrows on a real BrainError", () => {
    const err: unknown = new BrainError("policy_denied", "denied");
    expect(isBrainError(err)).toBe(true);
  });
  it("narrows on a structurally-matching error from another module copy", () => {
    const fake: unknown = {
      name: "BrainError",
      code: "policy_denied",
      message: "denied",
    };
    expect(isBrainError(fake)).toBe(true);
  });
  it("rejects plain Error", () => {
    expect(isBrainError(new Error("nope"))).toBe(false);
  });
  it("rejects non-objects", () => {
    expect(isBrainError("string")).toBe(false);
    expect(isBrainError(null)).toBe(false);
    expect(isBrainError(undefined)).toBe(false);
  });
});

describe("isBrainErrorEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    const e: BrainErrorEnvelope = {
      error: {
        code: "policy_denied",
        message: "denied",
        trace_id: "trc_abc",
        docs_url: "https://docs.brain.fi/errors/policy_denied",
      },
    };
    expect(isBrainErrorEnvelope(e)).toBe(true);
  });

  it("accepts an envelope with no optional fields", () => {
    expect(
      isBrainErrorEnvelope({
        error: { code: "internal_error", message: "boom" },
      }),
    ).toBe(true);
  });

  it("rejects flat / legacy envelopes", () => {
    expect(
      isBrainErrorEnvelope({ code: "internal_error", message: "boom" }),
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isBrainErrorEnvelope(null)).toBe(false);
    expect(isBrainErrorEnvelope("error")).toBe(false);
    expect(isBrainErrorEnvelope([])).toBe(false);
  });
});

describe("brainErrorFromEnvelope", () => {
  it("returns the typed subclass when the code matches", () => {
    const err = brainErrorFromEnvelope(
      {
        error: {
          code: "policy_denied",
          message: "rule blocked it",
          details: { rule_id: "r-1" },
          trace_id: "trc_xyz",
        },
      },
      422,
    );
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(err.code).toBe("policy_denied");
    expect(err.message).toBe("rule blocked it");
    expect(err.details).toEqual({ rule_id: "r-1" });
    expect(err.traceId).toBe("trc_xyz");
    expect(err.statusCode).toBe(422);
  });

  it("returns base BrainError for v0.1/v0.2 legacy codes (no subclass)", () => {
    const err = brainErrorFromEnvelope(
      {
        error: {
          code: "execution_proposal_not_found",
          message: "no such proposal",
        },
      },
      404,
    );
    expect(err).toBeInstanceOf(BrainError);
    expect(err).not.toBeInstanceOf(PolicyDeniedError);
    expect(err.code).toBe("execution_proposal_not_found");
    expect(err.statusCode).toBe(404);
  });

  it("forwards unknown codes (server ahead of client) as base BrainError", () => {
    const err = brainErrorFromEnvelope(
      {
        error: {
          code: "future_unreleased_code",
          message: "from the future",
        },
      },
      500,
    );
    expect(err).toBeInstanceOf(BrainError);
    expect(err.code).toBe("future_unreleased_code");
    expect(err.message).toBe("from the future");
  });

  it("uses default docs_url when server omits it", () => {
    const err = brainErrorFromEnvelope({
      error: { code: "policy_denied", message: "nope" },
    });
    expect(err.docsUrl).toBe("https://docs.brain.fi/errors/policy_denied");
  });
});
