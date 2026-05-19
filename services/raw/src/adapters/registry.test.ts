import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import { adapterForSourceType, adapterForWebhookProvider, listAdapters } from "./registry.js";

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

describe("listAdapters", () => {
  it("enumerates the registered adapters", () => {
    const all = listAdapters();
    expect(all.length).toBeGreaterThanOrEqual(7);
  });
});
