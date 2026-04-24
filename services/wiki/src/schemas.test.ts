import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/api/shared";
import { loadRegistry } from "./schemas.js";

describe("schema registry", () => {
  const reg = loadRegistry();

  it("loads schemas for every MVP entity kind", () => {
    for (const k of ["account", "counterparty", "transaction", "obligation", "policy", "agent"] as const) {
      expect(reg.entity[k]).toBeDefined();
    }
  });

  it("loads schemas for every MVP relation kind", () => {
    for (const k of ["transacted_with", "owes", "owed_by", "governed_by"] as const) {
      expect(reg.relation[k]).toBeDefined();
    }
  });

  it("validates a well-formed account entity", () => {
    expect(() =>
      reg.validateEntity("account", {
        display_name: "Chase Checking",
        kind: "bank_checking",
        currency: "USD",
      }),
    ).not.toThrow();
  });

  it("rejects an invalid account entity", () => {
    try {
      reg.validateEntity("account", { display_name: "x", kind: "unknown_kind" });
      expect.fail();
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) {
        expect(err.code).toBe("wiki_schema_validation_failed");
      }
    }
  });

  it("validates transaction with decimal amount string", () => {
    expect(() =>
      reg.validateEntity("transaction", {
        direction: "outbound",
        amount: "100.00",
        currency: "USD",
        posted_at: "2026-04-01T00:00:00Z",
      }),
    ).not.toThrow();
  });

  it("rejects transaction with non-numeric amount", () => {
    try {
      reg.validateEntity("transaction", {
        direction: "outbound",
        amount: "nonsense",
        currency: "USD",
        posted_at: "2026-04-01T00:00:00Z",
      });
      expect.fail();
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
    }
  });

  it("validates transacted_with relation", () => {
    expect(() =>
      reg.validateRelation("transacted_with", {
        transaction_id: "ent_01HQ7K3AAAAAAAAAAAAAAAAAAAA",
        amount: "12.50",
        currency: "USD",
        posted_at: "2026-04-01T00:00:00Z",
      }),
    ).not.toThrow();
  });
});
