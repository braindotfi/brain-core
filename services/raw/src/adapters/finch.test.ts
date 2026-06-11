import { describe, expect, it } from "vitest";
import {
  adapterForGenericIngest,
  adapterForSourceType,
  descriptorForSourceType,
} from "./registry.js";

// Scaffolded conformance skeleton. TODO(connector): add provider fixtures and
// assert backfill, deltas, idempotent dedup, signature rejection (webhooks),
// and the evidence/provenance defaults.
describe("finch connector", () => {
  it("registers the adapter under its provider-named source type", () => {
    expect(adapterForSourceType("finch").sourceType).toBe("finch");
  });

  it("is described by a ConnectorDescriptor with a registered parser", () => {
    const d = descriptorForSourceType("finch");
    expect(d.parserVersions).toContain("finch_v1");
  });

  it("is ingestible through the universal generic-push route", () => {
    expect(adapterForGenericIngest("finch").sourceType).toBe("finch");
  });
});
