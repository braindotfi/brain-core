import { describe, expect, it } from "vitest";
import { CONNECTOR_DESCRIPTORS } from "./descriptors.js";
import { descriptorForSourceType, listAdapters, listDescriptors } from "./registry.js";

describe("connector descriptors", () => {
  it("describes every registered adapter, and only registered adapters", () => {
    const adapterTypes = listAdapters()
      .map((a) => a.sourceType)
      .sort();
    const descriptorTypes = CONNECTOR_DESCRIPTORS.map((d) => d.connectorType).sort();
    expect(descriptorTypes).toEqual(adapterTypes);
  });

  it("capability claims match the methods each adapter implements", () => {
    for (const adapter of listAdapters()) {
      const d = descriptorForSourceType(adapter.sourceType);
      if (d.capabilities.incremental || d.capabilities.backfill) {
        expect(
          adapter.fetchIncremental,
          `${d.connectorType} claims incremental/backfill but has no fetchIncremental`,
        ).toBeDefined();
        expect(
          adapter.syncObjectTypes,
          `${d.connectorType} claims incremental/backfill but declares no syncObjectTypes`,
        ).toBeDefined();
      }
      if (adapter.fetchIncremental !== undefined) {
        expect(
          d.capabilities.incremental,
          `${d.connectorType} implements fetchIncremental but does not claim incremental`,
        ).toBe(true);
      }
      if (d.capabilities.webhooks) {
        expect(
          adapter.handleWebhook,
          `${d.connectorType} claims webhooks but has no handleWebhook`,
        ).toBeDefined();
      }
    }
  });

  it("declares sync object types consistently with the descriptor objectTypes", () => {
    for (const adapter of listAdapters()) {
      if (adapter.syncObjectTypes === undefined) continue;
      const d = descriptorForSourceType(adapter.sourceType);
      for (const spec of adapter.syncObjectTypes) {
        expect(
          d.objectTypes,
          `${d.connectorType} syncs '${spec.objectType}' but does not list it in objectTypes`,
        ).toContain(spec.objectType);
      }
    }
  });

  it("listDescriptors exposes the catalog; unknown types throw", () => {
    expect(listDescriptors().length).toBeGreaterThanOrEqual(10);
    expect(() => descriptorForSourceType("mystery")).toThrow();
  });
});
