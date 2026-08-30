import { computeServiceAuthSignatureV2 } from "@brain/shared";
import type { SurfaceName } from "@brain/surfaces";

export interface SurfaceActionRequest {
  tenantId: string;
  proposalId: string;
  paymentIntentId: string;
  surface: SurfaceName;
  externalActorId: string;
}

export interface SurfaceActionClient {
  approve(input: SurfaceActionRequest): Promise<{ quorumMet: boolean; status: string }>;
  execute(input: SurfaceActionRequest): Promise<{ outboxId: string; status: string }>;
}

export class HttpSurfaceActionClient implements SurfaceActionClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly signingSecret: string,
  ) {}

  public async approve(
    input: SurfaceActionRequest,
  ): Promise<{ quorumMet: boolean; status: string }> {
    const result = await this.call<{
      quorum_met: boolean;
      status: string;
    }>("approve", input);
    return { quorumMet: result.quorum_met, status: result.status };
  }

  public async execute(input: SurfaceActionRequest): Promise<{ outboxId: string; status: string }> {
    const result = await this.call<{ outbox_id: string; status: string }>("execute", input);
    return { outboxId: result.outbox_id, status: result.status };
  }

  private async call<T>(operation: "approve" | "execute", input: SurfaceActionRequest): Promise<T> {
    const body = JSON.stringify({
      tenant_id: input.tenantId,
      proposal_id: input.proposalId,
      payment_intent_id: input.paymentIntentId,
      surface: input.surface,
      external_actor_id: input.externalActorId,
    });
    const rawBody = Buffer.from(body, "utf8");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeServiceAuthSignatureV2(
      this.signingSecret,
      timestamp,
      input.tenantId,
      rawBody,
    );
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/v1/internal/surface-actions/${operation}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-brain-service-auth": signature,
          "x-brain-service-timestamp": timestamp,
          "x-brain-write-tenant": input.tenantId,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(`surface_action_${operation}_failed:${String(response.status)}`);
    }
    return (await response.json()) as T;
  }
}
