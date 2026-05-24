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
  /** H-04: the durable outbox row the worker will settle. */
  outboxId: string | undefined;
  /** H-04: null until the outbox worker dispatches the rail. */
  executionId: string | null | undefined;
  rail: string | undefined;
  status: "dispatching" | "dispatched" | "in_flight" | undefined;
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
      outboxId: body.outbox_id,
      executionId: body.execution_id,
      rail: body.rail,
      status: body.status,
    };
  }

  // --- Kill-switch + forensics (Agent Autonomy v3, 1b.3 / 2.4) ---

  /** Pause an approved PaymentIntent (approved → paused). */
  async pause(id: string): Promise<PaymentIntent> {
    const { data, error, response } = await this.http.POST("/payment-intents/{id}/pause", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  /** Resume a paused PaymentIntent — re-runs the live §6 gate first. */
  async resume(id: string): Promise<PaymentIntent> {
    const { data, error, response } = await this.http.POST("/payment-intents/{id}/resume", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  /** Typed forensic record: the intent, its executions + rail receipts, linking ids. */
  async replayInvestigation(id: string): Promise<Record<string, unknown>> {
    const { data, error, response } = await this.http.GET(
      "/payment-intents/{id}/replay-investigation",
      { params: { path: { id } } },
    );
    return unwrap(data, error, response.status) as Record<string, unknown>;
  }
}
