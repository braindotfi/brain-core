import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, paths } from "../generated/openapi.js";

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
}
