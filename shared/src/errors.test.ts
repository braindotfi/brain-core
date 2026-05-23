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

  it("contains the v0.3 docs codes from https://docs.brain.fi/resources/errors", () => {
    const docsCodes: BrainErrorCode[] = [
      // one representative per docs category
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
    for (const code of docsCodes) {
      expect(BRAIN_ERROR_CODES).toContain(code);
    }
  });

  it("splits the legacy payment_intent_gate_failed umbrella into 8 specific gate codes", () => {
    const gateCodes: BrainErrorCode[] = [
      "gate_no_policy_decision",
      "gate_policy_version_stale",
      "gate_counterparty_unverified",
      "gate_counterparty_sanctioned",
      "gate_balance_insufficient",
      "gate_approval_incomplete",
      "gate_session_key_invalid",
      "gate_audit_chain_stale",
    ];
    for (const code of gateCodes) {
      expect(BRAIN_ERROR_CODES).toContain(code);
    }
  });

  it("includes every §4.3 ledger/policy/payment_intent code with a status", () => {
    // Typed as string[] so the test compiles before the codes exist (TDD red).
    const codes: string[] = [
      "ledger_status_invalid",
      "ledger_balance_unavailable",
      "ledger_evidence_required",
      "ledger_reconciliation_conflict",
      "policy_decision_required",
      "agent_proposal_not_found",
      "agent_proposal_invalid_state",
      "agent_idempotency_conflict",
      "payment_intent_approval_required",
      "payment_intent_approval_invalid",
    ];
    for (const code of codes) {
      expect(BRAIN_ERROR_CODES as readonly string[]).toContain(code);
      expect(isBrainErrorCode(code)).toBe(true);
      if (isBrainErrorCode(code)) {
        expect(typeof httpStatusForCode(code)).toBe("number");
      }
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

  it("maps v0.3 auth/scope codes to 401/403 per docs table", () => {
    expect(httpStatusForCode("auth_invalid_key")).toBe(401);
    expect(httpStatusForCode("auth_expired")).toBe(401);
    expect(httpStatusForCode("auth_siwx_invalid")).toBe(401);
    expect(httpStatusForCode("source_credential_invalid")).toBe(401);
    expect(httpStatusForCode("scope_insufficient")).toBe(403);
    expect(httpStatusForCode("scope_hash_mismatch")).toBe(403);
    expect(httpStatusForCode("scope_expired")).toBe(403);
    expect(httpStatusForCode("tenant_access_denied")).toBe(403);
    expect(httpStatusForCode("tenant_suspended")).toBe(403);
  });

  it("maps policy denial and pre-execution gate failures to 422", () => {
    // Docs §api-reference/overview status table: 422 = Policy denied or
    // escalation required. All gate_* checks except version/session/audit-chain
    // are policy preconditions, so they map to 422 too.
    const policyAnd422Gate: BrainErrorCode[] = [
      "policy_denied",
      "policy_escalate",
      "insufficient_balance",
      "limits_exceeded",
      "gate_no_policy_decision",
      "gate_counterparty_unverified",
      "gate_counterparty_sanctioned",
      "gate_balance_insufficient",
      "gate_approval_incomplete",
    ];
    for (const code of policyAnd422Gate) {
      expect(httpStatusForCode(code)).toBe(422);
    }
  });

  it("maps stale-state gate codes to 409 and degraded codes to 503", () => {
    expect(httpStatusForCode("gate_policy_version_stale")).toBe(409);
    expect(httpStatusForCode("gate_session_key_invalid")).toBe(409);
    expect(httpStatusForCode("gate_audit_chain_stale")).toBe(503);
    expect(httpStatusForCode("maintenance_mode")).toBe(503);
  });

  it("maps upstream_timeout to 504 (not 503)", () => {
    // 503 vs 504 distinction: 503 = dependency known down / circuit open;
    // 504 = dependency reachable, didn't answer in time.
    expect(httpStatusForCode("upstream_timeout")).toBe(504);
    expect(httpStatusForCode("dependency_unavailable")).toBe(503);
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
