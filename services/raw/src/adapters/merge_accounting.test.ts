import { describe, expect, it } from "vitest";
import {
  adapterForGenericIngest,
  adapterForSourceType,
  descriptorForSourceType,
} from "./registry.js";

// Scaffolded conformance skeleton. TODO(connector): add provider fixtures and
// assert backfill, deltas, idempotent dedup, signature rejection (webhooks),
// and the evidence/provenance defaults.
describe("merge_accounting connector", () => {
  it("registers the adapter under its provider-named source type", () => {
    expect(adapterForSourceType("merge_accounting").sourceType).toBe("merge_accounting");
  });

  it("is described by a ConnectorDescriptor with a registered parser", () => {
    const d = descriptorForSourceType("merge_accounting");
    expect(d.parserVersions).toContain("merge_accounting_v1");
  });

  it("is ingestible through the universal generic-push route", () => {
    expect(adapterForGenericIngest("merge_accounting").sourceType).toBe("merge_accounting");
  });
});
