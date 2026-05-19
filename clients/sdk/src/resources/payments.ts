import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody, type PaymentIntent } from "../errors.js";
import type { paths } from "../generated/openapi.js";

export type CreatePaymentIntentBody = NonNullable<
  paths["/payment-intents"]["post"]["requestBody"]
>["content"]["application/json"];

export interface CreatePaymentIntentParams extends CreatePaymentIntentBody {
  /**
   * Caller-supplied key for deduplication. Sent as the `Idempotency-Key`
   * HTTP header. Strongly recommended for any production caller — the
   * server uses it to make `createPaymentIntent` retry-safe.
   */
  idempotencyKey?: string;
}

export interface ExecutionReceipt {
  paymentIntentId: string | undefined;
  executionId: string | undefined;
  rail: string | undefined;
  status: "dispatched" | "in_flight" | undefined;
}

export interface RejectPaymentIntentParams {
  reason?: string;
}

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class PaymentsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async create(params: CreatePaymentIntentParams): Promise<PaymentIntent> {
    const { idempotencyKey, ...body } = params;
    const headers: Record<string, string> = idempotencyKey
      ? { "Idempotency-Key": idempotencyKey }
      : {};
    const { data, error, response } = await this.http.POST("/payment-intents", { body, headers });
    return unwrap(data, error, response.status);
  }

  async get(id: string): Promise<PaymentIntent> {
    const { data, error, response } = await this.http.GET("/payment-intents/{id}", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  async approve(id: string): Promise<PaymentIntent> {
    const { data, error, response } = await this.http.POST("/payment-intents/{id}/approve", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  async reject(id: string, params: RejectPaymentIntentParams = {}): Promise<PaymentIntent> {
    const body = params.reason !== undefined ? { reason: params.reason } : undefined;
    const { data, error, response } = await this.http.POST("/payment-intents/{id}/reject", {
      params: { path: { id } },
      body,
    });
    return unwrap(data, error, response.status);
  }

  async execute(id: string): Promise<ExecutionReceipt> {
    const { data, error, response } = await this.http.POST("/payment-intents/{id}/execute", {
      params: { path: { id } },
    });
    const body = unwrap(data, error, response.status);
    return {
      paymentIntentId: body.payment_intent_id,
      executionId: body.execution_id,
      rail: body.rail,
      status: body.status,
    };
  }
}
