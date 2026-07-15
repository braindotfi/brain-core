import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_TRACE_POLICY, redact, type RedactionPolicy } from "./redaction.js";

const OPTS = { tenantHashKey: "tnt_acme_key" };

describe("redact", () => {
  it("forbids bank account identifiers instead of masking them", () => {
    for (const field of ["account_number", "account_no", "acct", "iban", "routing_number"]) {
      expect(() => redact(DEFAULT_AGENT_TRACE_POLICY, { [field]: "123456789" }, OPTS)).toThrow(
        new RegExp(`forbidden field "${field}"`),
      );
    }
  });

  it("hashes counterparty names recoverably and deterministically", () => {
    const a = redact(DEFAULT_AGENT_TRACE_POLICY, { vendor_name: "Acme Corp" }, OPTS) as Record<
      string,
      string
    >;
    const b = redact(DEFAULT_AGENT_TRACE_POLICY, { vendor_name: "Acme Corp" }, OPTS) as Record<
      string,
      string
    >;
    expect(a.vendor_name).toMatch(/^h:[0-9a-f]{64}$/);
    expect(a.vendor_name).toBe(b.vendor_name);
  });

  it("preserves amounts", () => {
    const out = redact(DEFAULT_AGENT_TRACE_POLICY, { amount: "5000", currency: "USD" }, OPTS);
    expect(out).toEqual({ amount: "5000", currency: "USD" });
  });

  it("drops email bodies but retains a hash", () => {
    const out = redact(
      DEFAULT_AGENT_TRACE_POLICY,
      { subject: "Invoice overdue", body: "secret prose" },
      OPTS,
    ) as Record<string, unknown>;
    expect(out.body).toBeUndefined();
    expect(out.subject).toBe("Invoice overdue");
    expect(out.body_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws on forbidden bank credentials", () => {
    expect(() =>
      redact(DEFAULT_AGENT_TRACE_POLICY, { plaid_access_token: "tok_123" }, OPTS),
    ).toThrow(/forbidden/);
  });

  it("recurses into nested objects and arrays", () => {
    expect(() =>
      redact(
        DEFAULT_AGENT_TRACE_POLICY,
        { tool: "x", args: [{ account_number: "999988887777" }] },
        OPTS,
      ),
    ).toThrow(/forbidden field "account_number"/);
  });

  it("stays in sync with the canonical policy JSON", () => {
    const json = JSON.parse(
      readFileSync(
        new URL("../../../schemas/redaction-policies/agent-trace-v1.json", import.meta.url),
        "utf8",
      ),
    ) as RedactionPolicy;
    expect(json).toEqual(DEFAULT_AGENT_TRACE_POLICY);
  });
});
