import type { Pool } from "pg";
import {
  ComplyAdvantageOfacScreener,
  ComplyAdvantagePepScreener,
  InMemoryOfacScreener,
  InMemoryPepScreener,
  LiveStripeIssuingCardIssuer,
  PostmarkNotificationService,
  RailPaymentReversalService,
  SumsubKycStore,
  UnwiredKycStore,
  withTenantScope,
  type AuditEmitter,
  type CardIssuer,
  type KycStore,
  type NotificationService,
  type OfacScreener,
  type PaymentReversalService,
  type PepScreener,
} from "@brain/shared";

interface IntegrationRow {
  provider: string;
  config: Record<string, unknown>;
}

export interface TenantProviderFactoryDeps {
  readonly pool: Pool;
  readonly audit?: AuditEmitter;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class TenantProviderFactory {
  public constructor(private readonly deps: TenantProviderFactoryDeps) {}

  public async ofac(tenantId: string): Promise<OfacScreener> {
    const row = await this.row(tenantId, "ofac");
    if (row?.provider === "comply_advantage") {
      const apiKey = this.env("COMPLY_ADVANTAGE_API_KEY");
      const endpoint = this.env("COMPLY_ADVANTAGE_ENDPOINT");
      if (apiKey !== undefined && endpoint !== undefined) {
        return new ComplyAdvantageOfacScreener({
          apiKey,
          endpoint,
          tenantId,
          ...(this.deps.audit !== undefined ? { audit: this.deps.audit } : {}),
        });
      }
    }
    return new InMemoryOfacScreener();
  }

  public async pep(tenantId: string): Promise<PepScreener> {
    const row = await this.row(tenantId, "pep");
    if (row?.provider === "comply_advantage") {
      const apiKey = this.env("COMPLY_ADVANTAGE_API_KEY");
      const endpoint = this.env("COMPLY_ADVANTAGE_ENDPOINT");
      if (apiKey !== undefined && endpoint !== undefined) {
        return new ComplyAdvantagePepScreener({
          apiKey,
          endpoint,
          tenantId,
          ...(this.deps.audit !== undefined ? { audit: this.deps.audit } : {}),
        });
      }
    }
    return new InMemoryPepScreener();
  }

  public async kyc(tenantId: string): Promise<KycStore> {
    const row = await this.row(tenantId, "kyc");
    if (row?.provider === "sumsub") {
      const appToken = this.env("SUMSUB_APP_TOKEN");
      const secret = this.env("SUMSUB_SECRET");
      if (appToken !== undefined && secret !== undefined) {
        return new SumsubKycStore({
          appToken,
          secret,
          tenantId,
          ...(this.deps.audit !== undefined ? { audit: this.deps.audit } : {}),
        });
      }
    }
    return new UnwiredKycStore();
  }

  public async cardIssuer(tenantId: string): Promise<CardIssuer | null> {
    const row = await this.row(tenantId, "card_issuer");
    if (row?.provider !== "stripe_issuing") return null;
    const apiKey = this.env("STRIPE_ISSUING_API_KEY");
    return apiKey === undefined
      ? null
      : new LiveStripeIssuingCardIssuer({
          apiKey,
          tenantId,
          ...(this.deps.audit !== undefined ? { audit: this.deps.audit } : {}),
        });
  }

  public async reversal(tenantId: string): Promise<PaymentReversalService> {
    const stripeApiKey = this.env("STRIPE_ISSUING_API_KEY");
    const firstMeridianApiKey = this.env("FIRST_MERIDIAN_API_KEY");
    const firstMeridianEndpoint = this.env("FIRST_MERIDIAN_ENDPOINT");
    return new RailPaymentReversalService({
      tenantId,
      ...(stripeApiKey !== undefined ? { stripeApiKey } : {}),
      ...(firstMeridianApiKey !== undefined ? { firstMeridianApiKey } : {}),
      ...(firstMeridianEndpoint !== undefined ? { firstMeridianEndpoint } : {}),
      ...(this.deps.audit !== undefined ? { audit: this.deps.audit } : {}),
    });
  }

  public async notification(tenantId: string): Promise<NotificationService | null> {
    const row = await this.row(tenantId, "notification");
    if (row?.provider !== "postmark") return null;
    const apiKey = this.env("POSTMARK_API_KEY");
    const fromEmail = this.env("POSTMARK_FROM_EMAIL");
    return apiKey === undefined || fromEmail === undefined
      ? null
      : new PostmarkNotificationService({
          apiKey,
          fromEmail,
          tenantId,
          ...(this.deps.audit !== undefined ? { audit: this.deps.audit } : {}),
        });
  }

  private async row(tenantId: string, adapterKind: string): Promise<IntegrationRow | null> {
    return withTenantScope(this.deps.pool, tenantId, async (client) => {
      const result = await client.query<IntegrationRow>(
        `SELECT provider, config
           FROM tenant_integrations
          WHERE tenant_id = $1 AND adapter_kind = $2 AND enabled = TRUE
          LIMIT 1`,
        [tenantId, adapterKind],
      );
      return result.rows[0] ?? null;
    });
  }

  private env(name: string): string | undefined {
    const value = (this.deps.env ?? process.env)[name];
    return value === "" ? undefined : value;
  }
}
