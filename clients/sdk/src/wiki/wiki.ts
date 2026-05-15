/**
 * `brain.wiki.*` — human-readable memory (Layer 3) + the LLM-in-hot-path
 * `wiki.question` endpoint.
 *
 * Source pages:
 *   - https://docs.brain.fi/api-reference/wiki-api
 *   - https://docs.brain.fi/sdks/wiki
 *
 * @packageDocumentation
 */

import type { BrainHttp } from "../http/index.js";
import type { Components } from "../index.js";

type Schemas = Components["schemas"];
export type WikiPage = Schemas["WikiPage"];
export type WikiEntity = Schemas["WikiEntity"];
export type WikiRelation = Schemas["WikiRelation"];
export type WikiAnswer = Schemas["WikiAnswer"];

/**
 * Citation discriminated-union per
 * https://docs.brain.fi/sdks/wiki ("Citation Types"). Some entries are
 * id-keyed; the raw artifact entry is sha256-keyed.
 */
export type Citation =
  | { readonly type: "ledger.transaction"; readonly id: string }
  | { readonly type: "ledger.invoice"; readonly id: string }
  | { readonly type: "ledger.balance"; readonly id: string }
  | { readonly type: "raw.artifact"; readonly sha256: string }
  | { readonly type: "wiki.entity"; readonly id: string };

export interface AskOptions {
  readonly tenantId: string;
  readonly question: string;
  readonly asOf?: string;
  readonly maxEvidenceDepth?: number;
}

export interface GetEntityOptions {
  readonly tenantId: string;
  readonly entityId: string;
  readonly includeNeighbors?: boolean;
  readonly asOf?: string;
}

export interface GetRelatedOptions {
  readonly tenantId: string;
  readonly entityId: string;
  readonly relationship?: string;
  readonly limit?: number;
}

export interface SearchOptions {
  readonly tenantId: string;
  readonly query: string;
  readonly kind?: string;
  readonly limit?: number;
}

export interface SemanticSearchOptions extends SearchOptions {
  readonly minScore?: number;
}

export interface GetPageOptions {
  readonly tenantId: string;
  readonly slugOrId: string;
}

export interface RegeneratePageOptions extends GetPageOptions {}

export class WikiModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * Natural-language question against the Wiki. The hot-path
   * `wiki.question` endpoint.
   *
   * Implements `POST /wiki/question` (operationId `askWiki`).
   * @see https://docs.brain.fi/api-reference/wiki-api
   * @see https://docs.brain.fi/sdks/wiki
   */
  public async question(opts: AskOptions): Promise<WikiAnswer> {
    return this.http.post<WikiAnswer>("/wiki/question", {
      tenantId: opts.tenantId,
      question: opts.question,
      ...(opts.asOf !== undefined ? { as_of: opts.asOf } : {}),
      ...(opts.maxEvidenceDepth !== undefined
        ? { max_evidence_depth: opts.maxEvidenceDepth }
        : {}),
    });
  }

  /**
   * Fetch a Wiki entity with optional one-hop neighbors.
   *
   * Implements `GET /wiki/entities/{entity_id}` (operationId `getWikiEntity`).
   */
  public async getEntity(
    opts: GetEntityOptions,
  ): Promise<{ entity: WikiEntity; neighbors?: Array<{ relation: WikiRelation; entity: WikiEntity }> }> {
    return this.http.get(
      `/wiki/entities/${encodeURIComponent(opts.entityId)}`,
      {
        query: {
          tenantId: opts.tenantId,
          include_neighbors: opts.includeNeighbors,
          as_of: opts.asOf,
        },
      },
    );
  }

  /**
   * Walk relationships from an entity.
   *
   * Implements `GET /wiki/entities/{id}/relationships` (operationId
   * `getEntityRelationships`).
   */
  public async getRelated(
    opts: GetRelatedOptions,
  ): Promise<{
    entity_id: string;
    relationships: Array<{ relation: WikiRelation; entity: WikiEntity }>;
  }> {
    return this.http.get(
      `/wiki/entities/${encodeURIComponent(opts.entityId)}/relationships`,
      {
        query: {
          tenantId: opts.tenantId,
          relationship: opts.relationship,
          limit: opts.limit,
        },
      },
    );
  }

  /**
   * Full-text search of the Wiki.
   *
   * Implements `POST /wiki/search` (operationId `searchWiki`).
   */
  public async search(
    opts: SearchOptions,
  ): Promise<{ results: WikiEntity[]; next_cursor: string | null }> {
    return this.http.post("/wiki/search", {
      tenantId: opts.tenantId,
      query: opts.query,
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }

  /**
   * Semantic (vector) search of the Wiki.
   *
   * Implements `POST /wiki/semantic_search` (operationId
   * `semanticSearchWiki`).
   */
  public async semanticSearch(
    opts: SemanticSearchOptions,
  ): Promise<{ results: Array<{ entity: WikiEntity; score: number }> }> {
    return this.http.post("/wiki/semantic_search", {
      tenantId: opts.tenantId,
      query: opts.query,
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.minScore !== undefined ? { min_score: opts.minScore } : {}),
    });
  }

  /**
   * Fetch a memory page by slug or id.
   *
   * Implements `GET /memory/pages/{slug_or_id}` (operationId
   * `getMemoryPage`).
   */
  public async getPage(opts: GetPageOptions): Promise<WikiPage> {
    return this.http.get<WikiPage>(
      `/memory/pages/${encodeURIComponent(opts.slugOrId)}`,
      { query: { tenantId: opts.tenantId } },
    );
  }

  /**
   * Regenerate a memory page from the current Ledger state.
   *
   * Implements `POST /memory/regenerate` (operationId
   * `regenerateMemoryPage`).
   */
  public async regeneratePage(opts: RegeneratePageOptions): Promise<WikiPage> {
    return this.http.post<WikiPage>("/memory/regenerate", {
      tenantId: opts.tenantId,
      slug_or_id: opts.slugOrId,
    });
  }
}
