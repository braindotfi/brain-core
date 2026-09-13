import { createHash } from "node:crypto";

export const COMMERCIAL_STRIPE_API_VERSION = "2026-02-25.clover" as const;
export const COMMERCIAL_STRIPE_WEBHOOK_VERSION = "2026-02-25.clover" as const;
export const COMMERCIAL_STRIPE_WEBHOOK_PATH = "/v1/commercial-billing/stripe/webhooks" as const;
export const STRIPE_TEST_CATALOG_APPLY_CONFIRMATION = "APPLY_STRIPE_TEST_CATALOG_V1" as const;

export type StripeCatalogAction = "inspect" | "plan" | "apply" | "verify";
export type StripePublicTier = "starter" | "growth" | "scale";
export type StripeBillingCurrency = "USD" | "EUR" | "GBP";
export type StripeBillingInterval = "month" | "year";

export interface StripeCatalogPrice {
  readonly localPriceRevisionId: string;
  readonly tier: StripePublicTier;
  readonly currency: StripeBillingCurrency;
  readonly interval: StripeBillingInterval;
  readonly amountMinorUnits: number;
}

export interface StripeCatalogSnapshot {
  readonly livemode: boolean;
  readonly apiVersion: string;
  readonly productKeys: readonly string[];
  readonly priceKeys: readonly string[];
}

export interface StripeCatalogPlan {
  readonly mode: "test";
  readonly apiVersion: typeof COMMERCIAL_STRIPE_API_VERSION;
  readonly catalogRevision: 1;
  readonly products: readonly string[];
  readonly prices: readonly StripeCatalogPrice[];
  readonly missingProductKeys: readonly string[];
  readonly missingPriceKeys: readonly string[];
  readonly requestDigest: string;
}

export interface StripeCatalogProvider {
  inspect(): Promise<StripeCatalogSnapshot>;
  ensureProduct(input: {
    readonly externalKey: string;
    readonly displayName: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<void>;
  ensurePrice(
    input: StripeCatalogPrice & {
      readonly externalKey: string;
      readonly productKey: string;
      readonly metadata: Readonly<Record<string, string>>;
    },
  ): Promise<void>;
}

export interface StripeCatalogOperatorInput {
  readonly action: StripeCatalogAction;
  readonly provider: StripeCatalogProvider;
  readonly providerMode: "test" | "live";
  readonly secretKey: string;
  readonly apiVersion: string;
  readonly webhookVersion: string;
  readonly confirmation?: string;
}

const MONTHLY_MINOR_UNITS: Readonly<
  Record<StripePublicTier, Readonly<Record<StripeBillingCurrency, number>>>
> = {
  starter: { USD: 9_900, EUR: 8_695, GBP: 7_483 },
  growth: { USD: 49_900, EUR: 43_828, GBP: 37_715 },
  scale: { USD: 250_000, EUR: 219_581, GBP: 188_955 },
};

export const STRIPE_PUBLIC_PRODUCT_KEYS = [
  "robotmoney_starter_v1",
  "robotmoney_growth_v1",
  "robotmoney_scale_v1",
] as const;

export const STRIPE_TEST_PRICE_CATALOG: readonly StripeCatalogPrice[] = (
  ["starter", "growth", "scale"] as const
).flatMap((tier) =>
  (["USD", "EUR", "GBP"] as const).flatMap((currency) => {
    const monthly = MONTHLY_MINOR_UNITS[tier][currency];
    return (["month", "year"] as const).map((interval) => ({
      localPriceRevisionId: `robotmoney_${tier}_${currency.toLowerCase()}_${interval}_v1`,
      tier,
      currency,
      interval,
      amountMinorUnits: interval === "month" ? monthly : monthly * 10,
    }));
  }),
);

function assertTestControlPlane(input: StripeCatalogOperatorInput): void {
  if (input.providerMode !== "test" || !input.secretKey.startsWith("sk_test_")) {
    throw new Error("commercial Stripe Phase 1 accepts test-mode credentials only");
  }
  if (
    input.apiVersion !== COMMERCIAL_STRIPE_API_VERSION ||
    input.webhookVersion !== COMMERCIAL_STRIPE_WEBHOOK_VERSION
  ) {
    throw new Error("commercial Stripe API and webhook versions must match the pinned contract");
  }
}

function priceKey(price: StripeCatalogPrice): string {
  return price.localPriceRevisionId;
}

function productKeyForTier(tier: StripePublicTier): string {
  return `robotmoney_${tier}_v1`;
}

function planFromSnapshot(snapshot: StripeCatalogSnapshot): StripeCatalogPlan {
  if (snapshot.livemode) {
    throw new Error("commercial Stripe Phase 1 rejects live-mode provider objects");
  }
  if (snapshot.apiVersion !== COMMERCIAL_STRIPE_API_VERSION) {
    throw new Error("Stripe snapshot API version does not match the pinned contract");
  }

  const productSet = new Set(snapshot.productKeys);
  const priceSet = new Set(snapshot.priceKeys);
  const missingProductKeys = STRIPE_PUBLIC_PRODUCT_KEYS.filter((key) => !productSet.has(key));
  const missingPriceKeys = STRIPE_TEST_PRICE_CATALOG.map(priceKey).filter(
    (key) => !priceSet.has(key),
  );
  const canonical = JSON.stringify({
    apiVersion: COMMERCIAL_STRIPE_API_VERSION,
    catalogRevision: 1,
    products: STRIPE_PUBLIC_PRODUCT_KEYS,
    prices: STRIPE_TEST_PRICE_CATALOG,
    missingProductKeys,
    missingPriceKeys,
  });

  return Object.freeze({
    mode: "test",
    apiVersion: COMMERCIAL_STRIPE_API_VERSION,
    catalogRevision: 1,
    products: STRIPE_PUBLIC_PRODUCT_KEYS,
    prices: STRIPE_TEST_PRICE_CATALOG,
    missingProductKeys,
    missingPriceKeys,
    requestDigest: createHash("sha256").update(canonical).digest("hex"),
  });
}

export async function runStripeCatalogOperator(
  input: StripeCatalogOperatorInput,
): Promise<StripeCatalogPlan> {
  assertTestControlPlane(input);
  const initial = await input.provider.inspect();
  const plan = planFromSnapshot(initial);

  if (input.action === "inspect" || input.action === "plan") {
    return plan;
  }

  if (input.action === "apply") {
    if (input.confirmation !== STRIPE_TEST_CATALOG_APPLY_CONFIRMATION) {
      throw new Error(`apply requires ${STRIPE_TEST_CATALOG_APPLY_CONFIRMATION}`);
    }
    for (const key of plan.missingProductKeys) {
      const tier = key.replace("robotmoney_", "").replace("_v1", "");
      await input.provider.ensureProduct({
        externalKey: key,
        displayName: `RobotMoney ${tier[0]?.toUpperCase() ?? ""}${tier.slice(1)}`,
        metadata: { brain_catalog_revision: "1", brain_external_key: key },
      });
    }
    for (const key of plan.missingPriceKeys) {
      const price = STRIPE_TEST_PRICE_CATALOG.find((candidate) => priceKey(candidate) === key);
      if (price === undefined) throw new Error(`missing local price contract for ${key}`);
      await input.provider.ensurePrice({
        ...price,
        externalKey: key,
        productKey: productKeyForTier(price.tier),
        metadata: {
          brain_catalog_revision: "1",
          brain_price_revision_id: price.localPriceRevisionId,
        },
      });
    }
  }

  const verified = planFromSnapshot(await input.provider.inspect());
  if (verified.missingProductKeys.length > 0 || verified.missingPriceKeys.length > 0) {
    throw new Error("Stripe test catalog verification found missing objects");
  }
  return verified;
}
