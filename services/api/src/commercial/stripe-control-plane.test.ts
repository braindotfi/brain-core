import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_STRIPE_API_VERSION,
  COMMERCIAL_STRIPE_WEBHOOK_VERSION,
  runStripeCatalogOperator,
  STRIPE_PUBLIC_PRODUCT_KEYS,
  STRIPE_TEST_CATALOG_APPLY_CONFIRMATION,
  STRIPE_TEST_PRICE_CATALOG,
  type StripeCatalogProvider,
  type StripeCatalogSnapshot,
} from "./stripe-control-plane.js";

class FakeProvider implements StripeCatalogProvider {
  readonly products = new Set<string>();
  readonly prices = new Set<string>();
  livemode = false;
  ensureCalls = 0;

  async inspect(): Promise<StripeCatalogSnapshot> {
    return {
      livemode: this.livemode,
      apiVersion: COMMERCIAL_STRIPE_API_VERSION,
      productKeys: [...this.products],
      priceKeys: [...this.prices],
    };
  }

  async ensureProduct(input: { readonly externalKey: string }): Promise<void> {
    this.ensureCalls += 1;
    this.products.add(input.externalKey);
  }

  async ensurePrice(input: { readonly externalKey: string }): Promise<void> {
    this.ensureCalls += 1;
    this.prices.add(input.externalKey);
  }
}

function input(provider: StripeCatalogProvider) {
  return {
    action: "apply" as const,
    provider,
    providerMode: "test" as const,
    secretKey: "sk_test_fixture",
    apiVersion: COMMERCIAL_STRIPE_API_VERSION,
    webhookVersion: COMMERCIAL_STRIPE_WEBHOOK_VERSION,
    confirmation: STRIPE_TEST_CATALOG_APPLY_CONFIRMATION,
  };
}

describe("commercial Stripe Phase 1 operator", () => {
  it("pins three public products and eighteen immutable prices", () => {
    expect(STRIPE_PUBLIC_PRODUCT_KEYS).toHaveLength(3);
    expect(STRIPE_TEST_PRICE_CATALOG).toHaveLength(18);
    expect(STRIPE_TEST_PRICE_CATALOG).toContainEqual(
      expect.objectContaining({
        localPriceRevisionId: "robotmoney_scale_gbp_year_v1",
        amountMinorUnits: 1_889_550,
      }),
    );
  });

  it("applies idempotently and verifies the resulting catalog", async () => {
    const provider = new FakeProvider();
    const first = await runStripeCatalogOperator(input(provider));
    expect(first.missingProductKeys).toEqual([]);
    expect(first.missingPriceKeys).toEqual([]);
    expect(provider.ensureCalls).toBe(21);

    await runStripeCatalogOperator(input(provider));
    expect(provider.ensureCalls).toBe(21);
  });

  it("rejects live credentials, live objects, and unpinned versions", async () => {
    const provider = new FakeProvider();
    await expect(
      runStripeCatalogOperator({ ...input(provider), secretKey: "sk_live_fixture" }),
    ).rejects.toThrow(/test-mode credentials only/);

    provider.livemode = true;
    await expect(runStripeCatalogOperator(input(provider))).rejects.toThrow(/live-mode/);

    provider.livemode = false;
    await expect(
      runStripeCatalogOperator({ ...input(provider), apiVersion: "unversioned" }),
    ).rejects.toThrow(/pinned contract/);
  });

  it("requires the exact apply confirmation", async () => {
    const { confirmation: _confirmation, ...withoutConfirmation } = input(new FakeProvider());
    await expect(runStripeCatalogOperator(withoutConfirmation)).rejects.toThrow(
      /APPLY_STRIPE_TEST_CATALOG_V1/,
    );
  });
});
