import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import {
  adapterForGenericIngest,
  adapterForSourceType,
  adapterForWebhookProvider,
  listAdapters,
} from "./registry.js";

describe("adapterForSourceType", () => {
  it("returns an adapter for every registered source_type enum value", () => {
    const expected = [
      "plaid",
      "stripe",
      "netsuite",
      "email_inbound",
      "csv_upload",
      "pdf_upload",
      "alchemy_wallet",
      "eth_address",
      "agent_contributed",
      "other",
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

  it("does not register the internal-only wiki_annotation type", () => {
    // wiki_annotation artifacts are written only by the Wiki annotate path
    // (direct ingestOne call), never assertable through the HTTP routes.
    try {
      adapterForSourceType("wiki_annotation");
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
    expect(adapterForWebhookProvider("alchemy").sourceType).toBe("alchemy_wallet");
    expect(adapterForWebhookProvider("netsuite").sourceType).toBe("netsuite");
    expect(adapterForWebhookProvider("generic_hmac").sourceType).toBe("other");
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
    const ok = [
      "csv_upload",
      "pdf_upload",
      "email_inbound",
      "netsuite",
      "alchemy_wallet",
      "eth_address",
      "agent_contributed",
      "other",
    ];
    for (const s of ok) {
      expect(adapterForGenericIngest(s).sourceType).toBe(s);
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
    expect(all.length).toBeGreaterThanOrEqual(10);
  });
});
