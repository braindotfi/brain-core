/**
 * IWikiMemoryService adapter.
 *
 * The MCP server needs IWikiMemoryService. WikiPageService covers listPages /
 * getPage / search / regenerate; `question` is built directly via askWiki +
 * the wiki deps. `annotate` writes through to Raw: every HITL correction
 * lands as an immutable Raw artifact so the audit chain stays intact, and a
 * downstream normalize worker / page regenerator picks the artifact up to
 * apply the override (matches the architecture intent in
 * IWikiMemoryService's "annotations write through to the Ledger via a
 * controlled write-through path that itself writes a Raw artifact").
 */

import {
  newWikiAnnotationId,
  withTenantScope,
  type IWikiMemoryService,
  type WikiPage,
  type QuestionRequest,
  type QuestionAnswer,
  type AnnotationInput,
  type ServiceCallContext,
} from "@brain/shared";
import { askWiki } from "@brain/wiki";
import { ingestOne } from "@brain/raw";
import type { RawDeps } from "@brain/raw";
import type { WikiDeps, WikiPageService } from "@brain/wiki";

/** sourceType marker for HITL Wiki annotations in raw_artifacts. */
export const WIKI_ANNOTATION_SOURCE_TYPE = "wiki_annotation";

export function buildWikiMemoryService(
  pageService: WikiPageService,
  wikiDeps: WikiDeps,
  rawDeps: RawDeps,
): IWikiMemoryService {
  return {
    async listPages(
      ctx: ServiceCallContext,
      f: { page_type?: WikiPage["page_type"]; q?: string; limit?: number },
    ) {
      return pageService.listPages(ctx, f);
    },
    async getPage(ctx: ServiceCallContext, slugOrId: string) {
      return pageService.getPage(ctx, slugOrId);
    },
    async regenerate(ctx: ServiceCallContext, slugOrId: string) {
      return pageService.regenerate(ctx, slugOrId);
    },
    async search(ctx: ServiceCallContext, q: string, limit: number) {
      return pageService.search(ctx, q, limit);
    },
    async question(ctx: ServiceCallContext, req: QuestionRequest): Promise<QuestionAnswer> {
      const result = await withTenantScope(wikiDeps.pool, ctx.tenantId, (client) =>
        askWiki(
          {
            client,
            llm: wikiDeps.llm,
            embed: wikiDeps.embed,
            redis: wikiDeps.redis,
            metrics: wikiDeps.metrics,
          },
          {
            question: req.question,
            asOf: req.asOf !== null ? new Date(req.asOf) : null,
            maxEvidenceDepth: req.maxEvidenceDepth,
            tenantId: ctx.tenantId,
            model: wikiDeps.questionModel,
          },
        ),
      );
      return {
        question: req.question,
        answer: result.answer,
        evidence: result.evidence,
        model: result.model,
        usage: result.usage,
        ...(result.cachedAt !== undefined ? { cachedAt: result.cachedAt } : {}),
      };
    },
    /**
     * HITL annotation write-through. Mints an annotation id, writes the
     * input as an immutable Raw artifact (one envelope per annotation),
     * and returns the linked ids so the caller can reference both records.
     *
     * The Raw artifact carries:
     *   sourceType: "wiki_annotation"
     *   sourceRef:  { annotation_id, target_type, target_id }
     *   body:       JSON-encoded { annotation_id, target_type, target_id,
     *                              body?, override_attributes?, created_by, created_at }
     *
     * Downstream consumers (Wiki regenerator, Ledger normalize) read these
     * artifacts to apply the correction. The audit trail (raw.ingest.new
     * event from ingestOne) is the durable record.
     */
    async annotate(
      ctx: ServiceCallContext,
      input: AnnotationInput,
    ): Promise<{ annotation_id: string; raw_artifact_id: string }> {
      const annotationId = newWikiAnnotationId();
      const payload: Record<string, unknown> = {
        annotation_id: annotationId,
        target_type: input.target_type,
        target_id: input.target_id,
        created_by: ctx.actor,
        created_at: new Date().toISOString(),
      };
      if (input.body !== undefined) payload.body = input.body;
      if (input.override_attributes !== undefined) {
        payload.override_attributes = input.override_attributes;
      }
      const result = await ingestOne(rawDeps, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        sourceType: WIKI_ANNOTATION_SOURCE_TYPE,
        sourceRef: {
          annotation_id: annotationId,
          target_type: input.target_type,
          target_id: input.target_id,
        },
        body: Buffer.from(JSON.stringify(payload), "utf8"),
        mimeType: "application/json",
      });
      return { annotation_id: annotationId, raw_artifact_id: result.rawId };
    },
  };
}
