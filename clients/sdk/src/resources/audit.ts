import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, operations, paths } from "../generated/openapi.js";

type AuditEvent = components["schemas"]["AuditEvent"];

export type ListAuditEventsParams = NonNullable<
  paths["/audit/events"]["get"]["parameters"]["query"]
>;

export type EntityType = NonNullable<
  paths["/audit/entity/{entityType}/{entityId}"]["get"]["parameters"]["path"]
>["entityType"];

export interface AuditEventListPage {
  events: AuditEvent[];
  nextCursor: string | null;
}

export interface InclusionProof {
  merkleRoot: string | undefined;
  merkleProof: string[] | undefined;
  anchorTxHash: string | undefined;
  anchorBlock: number | undefined;
}

export interface AuditEventWithProof {
  event: AuditEvent;
  inclusionProof: InclusionProof;
}

export interface EntityAuditHistory {
  entityType: string | undefined;
  entityId: string | undefined;
  events: AuditEvent[];
}

export interface ExportAuditRequest {
  format: "jsonl" | "csv";
  since: string;
  until: string;
  layers?: ("raw" | "wiki" | "policy" | "execution")[];
}

export interface ExportAuditJob {
  jobId: string | undefined;
}

export interface AnchorRecord {
  merkleRoot: string | undefined;
  eventCount: number | undefined;
  periodStart: string | undefined;
  periodEnd: string | undefined;
  onchainTxHash: string | undefined;
  onchainBlockNumber: number | undefined;
}

export interface VerifyAuditRequest {
  eventHash: string;
  merkleProof: string[];
  merkleRoot: string;
}

export interface VerifyAuditResult {
  verified: boolean;
  onchainBlock: number | null;
}

export interface WebhookEndpoint {
  id: string | undefined;
  url: string | undefined;
  enabledEvents: string[] | null | undefined;
  enabled: boolean | undefined;
  secretPreview: string | undefined;
  createdAt: string | undefined;
}

export type CreateWebhookEndpointRequest = NonNullable<
  operations["createAuditWebhookEndpoint"]["requestBody"]
>["content"]["application/json"];

export interface CreatedWebhookEndpoint {
  id: string | undefined;
  url: string | undefined;
  enabledEvents: string[] | null | undefined;
  enabled: boolean | undefined;
  /** Plaintext signing secret. Shown only in this response, never retrievable again. */
  secret: string | undefined;
  createdAt: string | undefined;
}

export interface WebhookDeadLetter {
  id: string | undefined;
  eventId: string | undefined;
  eventType: string | undefined;
  lastError: string | null | undefined;
  attemptCount: number | undefined;
  createdAt: string | undefined;
  lastAttemptAt: string | undefined;
}

export interface WebhookDeadLetterList {
  endpointId: string | undefined;
  deadLetters: WebhookDeadLetter[];
}

export interface WebhookReplayResult {
  endpointId: string | undefined;
  attempted: number | undefined;
  redelivered: number | undefined;
  stillFailing: number | undefined;
}

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class AnchorResource {
  constructor(private readonly http: BrainHttpClient) {}

  async latest(): Promise<AnchorRecord> {
    const { data, error, response } = await this.http.GET("/audit/anchor/latest");
    const body = unwrap(data, error, response.status);
    return {
      merkleRoot: body.merkle_root,
      eventCount: body.event_count,
      periodStart: body.period_start,
      periodEnd: body.period_end,
      onchainTxHash: body.onchain_tx_hash ?? undefined,
      onchainBlockNumber: body.onchain_block_number ?? undefined,
    };
  }
}

export class AuditResource {
  readonly anchor: AnchorResource;

  constructor(private readonly http: BrainHttpClient) {
    this.anchor = new AnchorResource(http);
  }

  async list(params: ListAuditEventsParams = {}): Promise<AuditEventListPage> {
    const { data, error, response } = await this.http.GET("/audit/events", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return {
      events: body.events ?? [],
      nextCursor: body.next_cursor ?? null,
    };
  }

  async get(eventId: string): Promise<AuditEventWithProof> {
    const { data, error, response } = await this.http.GET("/audit/event/{event_id}", {
      params: { path: { event_id: eventId } },
    });
    const body = unwrap(data, error, response.status);
    if (!body.event) {
      throw new BrainAPIError(response.status, undefined);
    }
    const proof = body.inclusion_proof ?? {};
    return {
      event: body.event,
      inclusionProof: {
        merkleRoot: proof.merkle_root,
        merkleProof: proof.merkle_proof,
        anchorTxHash: proof.anchor_tx_hash,
        anchorBlock: proof.anchor_block,
      },
    };
  }

  async history(entityType: EntityType, entityId: string): Promise<EntityAuditHistory> {
    const { data, error, response } = await this.http.GET("/audit/entity/{entityType}/{entityId}", {
      params: { path: { entityType, entityId } },
    });
    const body = unwrap(data, error, response.status);
    return {
      entityType: body.entity_type,
      entityId: body.entity_id,
      events: body.events ?? [],
    };
  }

  async export(req: ExportAuditRequest): Promise<ExportAuditJob> {
    const { data, error, response } = await this.http.POST("/audit/export", {
      body: req,
    });
    const body = unwrap(data, error, response.status);
    return {
      jobId: body.job_id,
    };
  }

  async verify(req: VerifyAuditRequest): Promise<VerifyAuditResult> {
    const { data, error, response } = await this.http.POST("/audit/verify", {
      body: {
        event_hash: req.eventHash,
        merkle_proof: req.merkleProof,
        merkle_root: req.merkleRoot,
      },
    });
    const body = unwrap(data, error, response.status);
    return {
      verified: body.verified ?? false,
      onchainBlock: body.onchain_block ?? null,
    };
  }

  /** Requires `audit:read`. Secrets are masked to an 8-character preview. */
  async listWebhookEndpoints(): Promise<WebhookEndpoint[]> {
    const { data, error, response } = await this.http.GET("/audit/webhooks/endpoints");
    const body = unwrap(data, error, response.status);
    return (body.endpoints ?? []).map((e) => ({
      id: e.id,
      url: e.url,
      enabledEvents: e.enabled_events,
      enabled: e.enabled,
      secretPreview: e.secret_preview,
      createdAt: e.created_at,
    }));
  }

  /**
   * Requires `audit:write`. As of this writing, no currently issued
   * credential (member session, owner token, agent, or API key) carries
   * `audit:write` anywhere in the codebase, so this will 403 with
   * `auth_scope_insufficient` until that's provisioned, the same
   * scope-provisioning gap pattern documented for `raw:admin` and
   * `canonical:read` elsewhere in this project. The signing secret is
   * generated server-side and returned exactly once, in this response;
   * subsequent `listWebhookEndpoints` calls only ever return a masked
   * preview.
   */
  async createWebhookEndpoint(req: CreateWebhookEndpointRequest): Promise<CreatedWebhookEndpoint> {
    const { data, error, response } = await this.http.POST("/audit/webhooks/endpoints", {
      body: req,
    });
    const body = unwrap(data, error, response.status);
    return {
      id: body.id,
      url: body.url,
      enabledEvents: body.enabled_events,
      enabled: body.enabled,
      secret: body.secret,
      createdAt: body.created_at,
    };
  }

  /**
   * Requires `audit:write`. As of this writing, no currently issued
   * credential (member session, owner token, agent, or API key) carries
   * `audit:write` anywhere in the codebase, so this will 403 with
   * `auth_scope_insufficient` until that's provisioned, the same
   * scope-provisioning gap pattern documented for `raw:admin` and
   * `canonical:read` elsewhere in this project.
   */
  async deleteWebhookEndpoint(id: string): Promise<void> {
    const { error, response } = await this.http.DELETE("/audit/webhooks/endpoints/{id}", {
      params: { path: { id } },
    });
    if (error !== undefined) {
      throw new BrainAPIError(response.status, error);
    }
  }

  /**
   * Requires `audit:read`. Outbound webhook deliveries that failed are
   * durably recorded here instead of being lost. Once `attemptCount` reaches
   * 5, a dead letter is exhausted and `replayWebhook` will no longer
   * auto-retry it.
   */
  async getWebhookDeadLetters(endpointId: string): Promise<WebhookDeadLetterList> {
    const { data, error, response } = await this.http.GET("/webhooks/{endpoint_id}/dead-letters", {
      params: { path: { endpoint_id: endpointId } },
    });
    const body = unwrap(data, error, response.status);
    return {
      endpointId: body.endpoint_id,
      deadLetters: (body.dead_letters ?? []).map((d) => ({
        id: d.id,
        eventId: d.event_id,
        eventType: d.event_type,
        lastError: d.last_error,
        attemptCount: d.attempt_count,
        createdAt: d.created_at,
        lastAttemptAt: d.last_attempt_at,
      })),
    };
  }

  /**
   * Requires `audit:write`. As of this writing, no currently issued
   * credential (member session, owner token, agent, or API key) carries
   * `audit:write` anywhere in the codebase, so this will 403 with
   * `auth_scope_insufficient` until that's provisioned, the same
   * scope-provisioning gap pattern documented for `raw:admin` and
   * `canonical:read` elsewhere in this project. Re-delivers each dead-letter
   * still under the attempt cap for this endpoint. A successful re-delivery
   * clears the row; a failure bumps its attempt count. Idempotent, safe to
   * call again.
   */
  async replayWebhook(endpointId: string): Promise<WebhookReplayResult> {
    const { data, error, response } = await this.http.POST("/webhooks/{endpoint_id}/replay", {
      params: { path: { endpoint_id: endpointId } },
    });
    const body = unwrap(data, error, response.status);
    return {
      endpointId: body.endpoint_id,
      attempted: body.attempted,
      redelivered: body.redelivered,
      stillFailing: body.still_failing,
    };
  }
}
