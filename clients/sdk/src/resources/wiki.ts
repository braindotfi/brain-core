import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, paths } from "../generated/openapi.js";

type WikiAnswer = components["schemas"]["WikiAnswer"];
type WikiEntity = components["schemas"]["WikiEntity"];
type WikiRelation = components["schemas"]["WikiRelation"];
type EvidenceChain = components["schemas"]["EvidenceChain"];
type EntityAnnotation = components["schemas"]["EntityAnnotation"];
type RelationAnnotation = components["schemas"]["RelationAnnotation"];

export interface AskParams {
  question: string;
  asOf?: string;
  maxEvidenceDepth?: number;
}

export type SearchWikiParams = NonNullable<paths["/wiki/search"]["get"]["parameters"]["query"]>;

export interface WikiSearchResult {
  results: WikiEntity[];
  nextCursor: string | null;
}

export interface GetWikiEntityParams {
  includeNeighbors?: boolean;
  asOf?: string;
}

export interface WikiEntityWithNeighbors {
  entity: WikiEntity | undefined;
  neighbors: Array<{ relation: WikiRelation | undefined; entity: WikiEntity | undefined }>;
}

export interface EntityVersionHistory {
  entityId: string | undefined;
  versions: WikiEntity[];
}

export interface AnnotationResult {
  annotationId: string | undefined;
  newVersionId: string | undefined;
}

export interface SchemaQuery {
  kind?: string;
}

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class WikiResource {
  constructor(private readonly http: BrainHttpClient) {}

  async question(params: AskParams): Promise<WikiAnswer> {
    const body: { question: string; as_of?: string; max_evidence_depth?: number } = {
      question: params.question,
    };
    if (params.asOf !== undefined) body.as_of = params.asOf;
    if (params.maxEvidenceDepth !== undefined) body.max_evidence_depth = params.maxEvidenceDepth;
    const { data, error, response } = await this.http.POST("/wiki/question", {
      body,
    });
    return unwrap(data, error, response.status);
  }

  async search(params: SearchWikiParams = {}): Promise<WikiSearchResult> {
    const { data, error, response } = await this.http.GET("/wiki/search", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return {
      results: body.results ?? [],
      nextCursor: body.next_cursor ?? null,
    };
  }

  async getEntity(
    entityId: string,
    params: GetWikiEntityParams = {},
  ): Promise<WikiEntityWithNeighbors> {
    const query: { include_neighbors?: boolean; as_of?: string } = {};
    if (params.includeNeighbors !== undefined) query.include_neighbors = params.includeNeighbors;
    if (params.asOf !== undefined) query.as_of = params.asOf;
    const { data, error, response } = await this.http.GET("/wiki/entity/{entity_id}", {
      params: { path: { entity_id: entityId }, query },
    });
    const body = unwrap(data, error, response.status);
    return {
      entity: body.entity,
      neighbors: body.neighbors?.map((n) => ({ relation: n.relation, entity: n.entity })) ?? [],
    };
  }

  async getEvidence(entityId: string): Promise<EvidenceChain> {
    const { data, error, response } = await this.http.GET("/wiki/entity/{entity_id}/evidence", {
      params: { path: { entity_id: entityId } },
    });
    return unwrap(data, error, response.status);
  }

  async getHistory(entityId: string): Promise<EntityVersionHistory> {
    const { data, error, response } = await this.http.GET("/wiki/entity/{entity_id}/history", {
      params: { path: { entity_id: entityId } },
    });
    const body = unwrap(data, error, response.status);
    return {
      entityId: body.entity_id,
      versions: body.versions ?? [],
    };
  }

  async annotate(annotation: EntityAnnotation | RelationAnnotation): Promise<AnnotationResult> {
    const { data, error, response } = await this.http.POST("/wiki/annotate", {
      body: annotation,
    });
    const body = unwrap(data, error, response.status);
    return {
      annotationId: body.annotation_id,
      newVersionId: body.new_version_id,
    };
  }

  async schema(params: SchemaQuery = {}): Promise<Record<string, unknown>> {
    const { data, error, response } = await this.http.GET("/wiki/schema", {
      params: { query: params },
    });
    return unwrap(data, error, response.status);
  }
}
