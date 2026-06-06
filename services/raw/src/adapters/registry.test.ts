import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import {
  adapterForGenericIngest,
  adapterForSourceType,
  adapterForWebhookProvider,
  listAdapters,
} from "./registry.js";

describe("adapterForSourceType", () => {
  it("returns an adapter for every OpenAPI source_type enum value", () => {
    const expected = [
      "plaid",
      "erp_netsuite",
      "email",
      "upload",
      "chain_evm",
      "stripe",
      "agent_contributed",
    ];
    for (const s of expected) expect(adapterForSourceType(s).sourceType).toBe(s);
  });

  it("throws raw_source_unsupported on unknown source_type", () => {
    try {
      adapterForSourceType("mystery");
      expect.fail();
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) expect(err.code).toBe("raw_source_unsupported");
    }
  });
});

describe("adapterForWebhookProvider", () => {
  it("maps each provider value from the OpenAPI enum", () => {
    expect(adapterForWebhookProvider("plaid").sourceType).toBe("plaid");
    expect(adapterForWebhookProvider("stripe").sourceType).toBe("stripe");
    expect(adapterForWebhookProvider("alchemy").sourceType).toBe("chain_evm");
    expect(adapterForWebhookProvider("netsuite").sourceType).toBe("erp_netsuite");
    expect(adapterForWebhookProvider("generic_hmac").sourceType).toBe("upload");
  });
});

describe("adapterForGenericIngest (authenticated provenance, Codex P1)", () => {
  it("rejects high-trust provider source types with raw_source_reserved", () => {
    for (const reserved of ["plaid", "stripe"]) {
      try {
        adapterForGenericIngest(reserved);
        expect.fail(`expected ${reserved} to be reserved`);
      } catch (err) {
        expect(isBrainError(err)).toBe(true);
        if (isBrainError(err)) expect(err.code).toBe("raw_source_reserved");
      }
    }
  });

  it("permits the medium/low-trust source types on the generic route", () => {
    for (const ok of ["upload", "email", "erp_netsuite", "chain_evm", "agent_contributed"]) {
      expect(adapterForGenericIngest(ok).sourceType).toBe(ok);
    }
  });

  it("still rejects an unknown source_type as raw_source_unsupported", () => {
    try {
      adapterForGenericIngest("mystery");
      expect.fail();
    } catch (err) {
      if (isBrainError(err)) expect(err.code).toBe("raw_source_unsupported");
    }
  });
});

describe("listAdapters", () => {
  it("enumerates the registered adapters", () => {
    const all = listAdapters();
    expect(all.length).toBeGreaterThanOrEqual(7);
  });
});
