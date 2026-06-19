import { describe, expect, it } from "vitest";
import type { ConnectorDescriptor, ConnectorTrustTier } from "./descriptors.js";
import { assertPartnerConnectorIsolation, assertRegistryPartnerIsolation } from "./isolation.js";

function descriptor(
  connectorType: string,
  trustTier: ConnectorTrustTier,
  overrides: Partial<ConnectorDescriptor> = {},
): ConnectorDescriptor {
  return {
    connectorType: connectorType as ConnectorDescriptor["connectorType"],
    version: "1.0.0",
    category: "other",
    delivery: ["file"],
    origin: "customer",
    trustTier,
    format: ["structured"],
    authentication: ["none"],
    capabilities: {
      discovery: false,
      backfill: false,
      incremental: false,
      webhooks: false,
      refresh: false,
      updates: false,
      deletes: false,
    },
    objectTypes: [],
    parserVersions: [],
    ...overrides,
  };
}

describe("assertPartnerConnectorIsolation", () => {
  it("passes when there are no partner-tier connectors", () => {
    expect(() =>
      assertPartnerConnectorIsolation({
        descriptors: [descriptor("plaid", "first_party"), descriptor("stripe", "first_party")],
        registeredSourceTypes: new Set(["plaid", "stripe"]),
      }),
    ).not.toThrow();
  });

  it("passes for a correctly out-of-process partner connector", () => {
    expect(() =>
      assertPartnerConnectorIsolation({
        descriptors: [descriptor("acme_partner", "partner")],
        registeredSourceTypes: new Set(["plaid"]),
      }),
    ).not.toThrow();
  });

  it("rejects a partner connector with an in-process adapter registered", () => {
    expect(() =>
      assertPartnerConnectorIsolation({
        descriptors: [descriptor("acme_partner", "partner")],
        registeredSourceTypes: new Set(["acme_partner"]),
      }),
    ).toThrow(/in-process SourceAdapter registered/);
  });

  it("rejects a partner connector that declares a Ledger parser", () => {
    expect(() =>
      assertPartnerConnectorIsolation({
        descriptors: [descriptor("acme_partner", "partner", { parserVersions: ["acme_v1"] })],
        registeredSourceTypes: new Set(),
      }),
    ).toThrow(/must not register a Ledger parser/);
  });

  it("rejects a partner connector that declares webhook delivery", () => {
    expect(() =>
      assertPartnerConnectorIsolation({
        descriptors: [descriptor("acme_partner", "partner", { delivery: ["webhook"] })],
        registeredSourceTypes: new Set(),
      }),
    ).toThrow(/webhook delivery/);
  });

  it("reports every violation for a maximally-misdeclared partner connector", () => {
    expect(() =>
      assertPartnerConnectorIsolation({
        descriptors: [
          descriptor("acme_partner", "partner", {
            delivery: ["webhook"],
            parserVersions: ["acme_v1"],
          }),
        ],
        registeredSourceTypes: new Set(["acme_partner"]),
      }),
    ).toThrow(/SourceAdapter registered.*Ledger parser.*webhook delivery/s);
  });
});

describe("assertRegistryPartnerIsolation", () => {
  it("passes for the live registry (every shipped connector is first-party)", () => {
    expect(() => assertRegistryPartnerIsolation()).not.toThrow();
  });
});
