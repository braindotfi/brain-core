import {
  bearerHeaders,
  fetchJson,
  providerSetup,
  withProviderFallback,
  type ProviderAdapterOptions,
  type ProviderSetupState,
} from "./provider-support.js";

export interface AdapterReference {
  readonly reference_id: string;
  readonly status: string;
}

export interface CardIssuer {
  freeze(cardId: string): Promise<AdapterReference>;
  unfreeze(cardId: string): Promise<AdapterReference>;
  reissue(cardId: string): Promise<AdapterReference>;
}

export interface DisputeService {
  file(txnId: string, reason: string): Promise<AdapterReference>;
  submit_evidence(disputeId: string, evidence: unknown): Promise<AdapterReference>;
}

export interface PaymentReversalService {
  refund(txnId: string, amount: string, reason: string): Promise<AdapterReference>;
}

export interface LedgerDecisionService {
  commit_match(candidateId: string): Promise<AdapterReference>;
  rollback_match(candidateId: string): Promise<AdapterReference>;
}

export type LedgerService = LedgerDecisionService;

export interface NotificationService {
  email(
    to: string,
    subject: string,
    body: string,
    attachments?: readonly unknown[],
  ): Promise<AdapterReference>;
  task(assignee: string, title: string, context: unknown): Promise<AdapterReference>;
}

export class InMemoryCardIssuer implements CardIssuer {
  async freeze(cardId: string): Promise<AdapterReference> {
    return { reference_id: `card_freeze:${cardId}`, status: "frozen" };
  }

  async unfreeze(cardId: string): Promise<AdapterReference> {
    return { reference_id: `card_unfreeze:${cardId}`, status: "unfrozen" };
  }

  async reissue(cardId: string): Promise<AdapterReference> {
    return { reference_id: `card_reissue:${cardId}`, status: "reissued" };
  }
}

export class TodoCardIssuer implements CardIssuer {
  constructor(readonly provider: "stripe_issuing" | "marqeta" | "first_meridian") {}

  async freeze(cardId: string): Promise<AdapterReference> {
    return { reference_id: `${this.provider}:freeze:${cardId}`, status: "stubbed" };
  }

  async unfreeze(cardId: string): Promise<AdapterReference> {
    return { reference_id: `${this.provider}:unfreeze:${cardId}`, status: "stubbed" };
  }

  async reissue(cardId: string): Promise<AdapterReference> {
    return { reference_id: `${this.provider}:reissue:${cardId}`, status: "stubbed" };
  }
}

export class StripeIssuingCardIssuer extends TodoCardIssuer {
  constructor() {
    super("stripe_issuing");
  }
}

export class MarqetaCardIssuer extends TodoCardIssuer {
  constructor() {
    super("marqeta");
  }
}

export class FirstMeridianCardIssuer extends TodoCardIssuer {
  constructor() {
    super("first_meridian");
  }
}

export class NymCardIssuerTodo implements CardIssuer {
  async freeze(cardId: string): Promise<AdapterReference> {
    return { reference_id: `nymcard:freeze:${cardId}`, status: "requires_setup" };
  }

  async unfreeze(cardId: string): Promise<AdapterReference> {
    return { reference_id: `nymcard:unfreeze:${cardId}`, status: "requires_setup" };
  }

  async reissue(cardId: string): Promise<AdapterReference> {
    return { reference_id: `nymcard:reissue:${cardId}`, status: "requires_setup" };
  }
}

export interface StripeIssuingCardIssuerOptions extends ProviderAdapterOptions {
  readonly apiKey: string;
}

export class LiveStripeIssuingCardIssuer implements CardIssuer {
  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    return providerSetup("stripe_issuing", env, ["STRIPE_ISSUING_API_KEY"]);
  }

  private readonly fetchImpl: typeof fetch;
  private readonly fallback = new InMemoryCardIssuer();

  public constructor(private readonly opts: StripeIssuingCardIssuerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public freeze(cardId: string): Promise<AdapterReference> {
    return this.updateCard(cardId, "freeze", { status: "inactive" }, () =>
      this.fallback.freeze(cardId),
    );
  }

  public unfreeze(cardId: string): Promise<AdapterReference> {
    return this.updateCard(cardId, "unfreeze", { status: "active" }, () =>
      this.fallback.unfreeze(cardId),
    );
  }

  public reissue(cardId: string): Promise<AdapterReference> {
    return withProviderFallback(
      { adapterKind: "card_issuer", provider: "stripe_issuing", operation: "reissue" },
      this.opts,
      async () => {
        const raw = await fetchJson(
          this.fetchImpl,
          `https://api.stripe.com/v1/issuing/cards/${encodeURIComponent(cardId)}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.opts.apiKey}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ replacement_for: cardId, status: "active" }).toString(),
          },
        );
        const ref = raw as { id?: string; status?: string };
        return {
          reference_id: ref.id ?? `stripe_reissue:${cardId}`,
          status: ref.status ?? "reissued",
        };
      },
      () => this.fallback.reissue(cardId),
    );
  }

  private updateCard(
    cardId: string,
    operation: string,
    body: Record<string, string>,
    fallback: () => Promise<AdapterReference>,
  ): Promise<AdapterReference> {
    return withProviderFallback(
      { adapterKind: "card_issuer", provider: "stripe_issuing", operation },
      this.opts,
      async () => {
        const raw = await fetchJson(
          this.fetchImpl,
          `https://api.stripe.com/v1/issuing/cards/${encodeURIComponent(cardId)}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.opts.apiKey}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(body).toString(),
          },
        );
        const ref = raw as { id?: string; status?: string };
        return { reference_id: ref.id ?? `stripe_card:${cardId}`, status: ref.status ?? operation };
      },
      fallback,
    );
  }
}

export class InMemoryDisputeService implements DisputeService {
  async file(txnId: string, reason: string): Promise<AdapterReference> {
    return { reference_id: `dispute_file:${txnId}:${reason}`, status: "filed" };
  }

  async submit_evidence(disputeId: string, _evidence: unknown): Promise<AdapterReference> {
    return { reference_id: `dispute_evidence:${disputeId}`, status: "submitted" };
  }
}

export interface ChargeflowDisputeServiceOptions extends ProviderAdapterOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
}

export class ChargeflowDisputeService implements DisputeService {
  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    return providerSetup("chargeflow", env, ["CHARGEFLOW_API_KEY"]);
  }

  private readonly fetchImpl: typeof fetch;
  private readonly fallback = new InMemoryDisputeService();

  public constructor(private readonly opts: ChargeflowDisputeServiceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public file(txnId: string, reason: string): Promise<AdapterReference> {
    return withProviderFallback(
      { adapterKind: "dispute", provider: "chargeflow", operation: "file" },
      this.opts,
      async () => {
        const raw = await fetchJson(this.fetchImpl, `${this.endpoint()}/disputes`, {
          method: "POST",
          headers: bearerHeaders(this.opts.apiKey),
          body: JSON.stringify({ transaction_id: txnId, reason }),
        });
        const ref = raw as { id?: string; status?: string };
        return { reference_id: ref.id ?? `chargeflow:${txnId}`, status: ref.status ?? "submitted" };
      },
      () => this.fallback.file(txnId, reason),
    );
  }

  public submit_evidence(disputeId: string, evidence: unknown): Promise<AdapterReference> {
    return withProviderFallback(
      { adapterKind: "dispute", provider: "chargeflow", operation: "submit_evidence" },
      this.opts,
      async () => {
        const raw = await fetchJson(
          this.fetchImpl,
          `${this.endpoint()}/disputes/${encodeURIComponent(disputeId)}/evidence`,
          {
            method: "POST",
            headers: bearerHeaders(this.opts.apiKey),
            body: JSON.stringify({ evidence }),
          },
        );
        const ref = raw as { id?: string; status?: string };
        return {
          reference_id: ref.id ?? `chargeflow_evidence:${disputeId}`,
          status: ref.status ?? "submitted",
        };
      },
      () => this.fallback.submit_evidence(disputeId, evidence),
    );
  }

  private endpoint(): string {
    return (this.opts.endpoint ?? "https://api.chargeflow.io/v1").replace(/\/+$/, "");
  }
}

export class InMemoryPaymentReversalService implements PaymentReversalService {
  async refund(txnId: string, amount: string, reason: string): Promise<AdapterReference> {
    return { reference_id: `refund:${txnId}:${amount}:${reason}`, status: "refunded" };
  }
}

export interface RailPaymentReversalServiceOptions extends ProviderAdapterOptions {
  readonly stripeApiKey?: string;
  readonly firstMeridianApiKey?: string;
  readonly firstMeridianEndpoint?: string;
}

export class RailPaymentReversalService implements PaymentReversalService {
  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    const missing = [
      ...providerSetup("stripe_issuing", env, ["STRIPE_ISSUING_API_KEY"]).missing_env,
      ...providerSetup("first_meridian", env, ["FIRST_MERIDIAN_API_KEY", "FIRST_MERIDIAN_ENDPOINT"])
        .missing_env,
    ];
    return { provider: "rail_reversal", requires_setup: missing.length > 0, missing_env: missing };
  }

  private readonly fetchImpl: typeof fetch;
  private readonly fallback = new InMemoryPaymentReversalService();

  public constructor(private readonly opts: RailPaymentReversalServiceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public refund(txnId: string, amount: string, reason: string): Promise<AdapterReference> {
    if (txnId.startsWith("wire_")) {
      return Promise.resolve({
        reference_id: `wire_manual:${txnId}`,
        status: `manual_required:${reason}`,
      });
    }
    if (txnId.startsWith("ach_")) return this.reverseAch(txnId, amount, reason);
    return this.refundCard(txnId, amount, reason);
  }

  private refundCard(txnId: string, amount: string, reason: string): Promise<AdapterReference> {
    if (this.opts.stripeApiKey === undefined) return this.fallback.refund(txnId, amount, reason);
    return withProviderFallback(
      { adapterKind: "reversal", provider: "stripe_issuing", operation: "refund" },
      this.opts,
      async () => {
        const raw = await fetchJson(this.fetchImpl, "https://api.stripe.com/v1/refunds", {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.stripeApiKey}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ charge: txnId, amount, reason }).toString(),
        });
        const ref = raw as { id?: string; status?: string };
        return {
          reference_id: ref.id ?? `stripe_refund:${txnId}`,
          status: ref.status ?? "submitted",
        };
      },
      () => this.fallback.refund(txnId, amount, reason),
    );
  }

  private reverseAch(txnId: string, amount: string, reason: string): Promise<AdapterReference> {
    if (
      this.opts.firstMeridianApiKey === undefined ||
      this.opts.firstMeridianEndpoint === undefined
    ) {
      return this.fallback.refund(txnId, amount, reason);
    }
    return withProviderFallback(
      { adapterKind: "reversal", provider: "first_meridian", operation: "nacha_return" },
      this.opts,
      async () => {
        const raw = await fetchJson(
          this.fetchImpl,
          `${this.opts.firstMeridianEndpoint!.replace(/\/+$/, "")}/ach/returns`,
          {
            method: "POST",
            headers: bearerHeaders(this.opts.firstMeridianApiKey!),
            body: JSON.stringify({ transaction_id: txnId, amount, reason }),
          },
        );
        const ref = raw as { id?: string; status?: string };
        return {
          reference_id: ref.id ?? `first_meridian_return:${txnId}`,
          status: ref.status ?? "submitted",
        };
      },
      () => this.fallback.refund(txnId, amount, reason),
    );
  }
}

export class InMemoryLedgerDecisionService implements LedgerDecisionService {
  async commit_match(candidateId: string): Promise<AdapterReference> {
    return { reference_id: `match_commit:${candidateId}`, status: "committed" };
  }

  async rollback_match(candidateId: string): Promise<AdapterReference> {
    return { reference_id: `match_rollback:${candidateId}`, status: "rolled_back" };
  }
}

export class InMemoryNotificationService implements NotificationService {
  async email(
    to: string,
    subject: string,
    _body: string,
    _attachments?: readonly unknown[],
  ): Promise<AdapterReference> {
    return { reference_id: `email:${to}:${subject}`, status: "sent" };
  }

  async task(assignee: string, title: string, _context: unknown): Promise<AdapterReference> {
    return { reference_id: `task:${assignee}:${title}`, status: "created" };
  }
}

export interface PostmarkNotificationServiceOptions extends ProviderAdapterOptions {
  readonly apiKey: string;
  readonly fromEmail: string;
}

export class PostmarkNotificationService implements NotificationService {
  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    return providerSetup("postmark", env, ["POSTMARK_API_KEY", "POSTMARK_FROM_EMAIL"]);
  }

  private readonly fetchImpl: typeof fetch;
  private readonly fallback = new InMemoryNotificationService();

  public constructor(private readonly opts: PostmarkNotificationServiceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public email(
    to: string,
    subject: string,
    body: string,
    attachments?: readonly unknown[],
  ): Promise<AdapterReference> {
    return withProviderFallback(
      { adapterKind: "notification", provider: "postmark", operation: "email" },
      this.opts,
      async () => {
        const raw = await fetchJson(this.fetchImpl, "https://api.postmarkapp.com/email", {
          method: "POST",
          headers: {
            "x-postmark-server-token": this.opts.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            From: this.opts.fromEmail,
            To: to,
            Subject: subject,
            TextBody: body,
            Attachments: attachments ?? [],
          }),
        });
        const ref = raw as { MessageID?: string; ErrorCode?: number };
        return {
          reference_id: ref.MessageID ?? `postmark:${to}:${subject}`,
          status: ref.ErrorCode === 0 ? "sent" : "submitted",
        };
      },
      () => this.fallback.email(to, subject, body, attachments),
    );
  }

  public task(assignee: string, title: string, context: unknown): Promise<AdapterReference> {
    return this.fallback.task(assignee, title, context);
  }
}

export interface TwilioSmsOptions extends ProviderAdapterOptions {
  readonly accountSid: string;
  readonly authToken: string;
  readonly fromNumber?: string;
}

export class TwilioSmsService {
  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    return providerSetup("twilio", env, ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]);
  }

  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly opts: TwilioSmsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public async sms(to: string, body: string): Promise<AdapterReference> {
    if (this.opts.fromNumber === undefined) {
      return { reference_id: `twilio_unconfigured:${to}`, status: "stubbed" };
    }
    return withProviderFallback(
      { adapterKind: "notification", provider: "twilio", operation: "sms" },
      this.opts,
      async () => {
        const raw = await fetchJson(
          this.fetchImpl,
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`,
          {
            method: "POST",
            headers: {
              authorization: `Basic ${Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString("base64")}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              From: this.opts.fromNumber!,
              To: to,
              Body: body,
            }).toString(),
          },
        );
        const ref = raw as { sid?: string; status?: string };
        return { reference_id: ref.sid ?? `twilio:${to}`, status: ref.status ?? "submitted" };
      },
      async () => ({ reference_id: `sms:${to}`, status: "stubbed" }),
    );
  }
}
