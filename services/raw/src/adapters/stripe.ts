/**
 * Stripe source adapter (Phase 3 connector 2).
 *
 * Authenticated cursor pull (ingestion method 2) across six per-object-type
 * partitions (§10): balance_transaction, charge, payout, refund, dispute,
 * customer. Each partition pages a Stripe list endpoint:
 *
 *  - Backfill walks pages newest-first via `starting_after` until
 *    `has_more` is false, accumulating the highest `created` seen.
 *  - Delta runs filter `created[gt] = watermark` and page the same way, so
 *    only objects newer than the committed high-water mark are re-pulled.
 *  - The checkpoint commits `watermark_created` only when a walk completes;
 *    a crash mid-walk resumes from `page_after` and the envelope
 *    idempotency key (stable per page position) absorbs the replay.
 *
 * The connected Stripe account id is fetched once (GET /v1/account) and
 * carried in the checkpoint + artifact sourceRef so the interpreter can
 * attribute pages to a ledger account without re-contacting Stripe.
 *
 * Webhook ingestion (signed push) is the other modality; until its
 * signature verification lands the handler returns 501 and pull is the
 * primary path (webhooks normally schedule a synchronization anyway, §8).
 */

import { brainError } from "@brain/shared";
import { stripeAccountId, stripeListPage } from "./stripe-client.js";
import type {
  FetchedArtifact,
  FetchIncrementalContext,
  FetchIncrementalResult,
  SourceAdapter,
} from "./types.js";

interface StripeCheckpoint {
  stripe_account_id?: string;
  /** Committed high-water mark (epoch seconds); null until the first walk completes. */
  watermark_created: number | null;
  /** Mid-walk pagination cursor (`starting_after`); null between walks. */
  page_after: string | null;
  /** Highest `created` seen during the current walk; promoted to the watermark at walk end. */
  pending_watermark: number | null;
}

const LIST_PATHS: Readonly<Record<string, { path: string; schema: string }>> = {
  balance_transaction: {
    path: "/v1/balance_transactions",
    schema: "stripe.balance_transactions.v1",
  },
  charge: { path: "/v1/charges", schema: "stripe.charges.v1" },
  payout: { path: "/v1/payouts", schema: "stripe.payouts.v1" },
  refund: { path: "/v1/refunds", schema: "stripe.refunds.v1" },
  dispute: { path: "/v1/disputes", schema: "stripe.disputes.v1" },
  customer: { path: "/v1/customers", schema: "stripe.customers.v1" },
};

interface StripeEventEnvelope {
  id?: string;
  type?: string;
  account?: string;
  created?: number;
}

export const StripeAdapter: SourceAdapter = {
  sourceType: "stripe",
  // High-trust provider: only the signature-verified webhook or the
  // authenticated pull may create stripe artifacts, never the generic
  // caller-supplied /raw/ingest route.
  providerAuthenticatedOnly: true,
  /**
   * Signed event push (already signature-verified by the webhook route).
   * The event lands verbatim as evidence; webhooks normally SCHEDULE a
   * synchronization rather than acting as the authoritative record (§8) —
   * the pull partitions remain the canonical reader, so no interpreter
   * promotes webhook events yet.
   */
  async handleWebhook(_tenantId, rawBody): Promise<FetchedArtifact[]> {
    let parsed: StripeEventEnvelope;
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as StripeEventEnvelope;
    } catch {
      throw brainError("request_body_invalid", "Stripe webhook body was not JSON");
    }
    const eventId = typeof parsed.id === "string" ? parsed.id : "unknown";
    return [
      {
        body: rawBody,
        mimeType: "application/json",
        sourceRef: {
          provider: "stripe",
          event_id: eventId,
          event_type: parsed.type ?? "unknown",
          stripe_account_id: parsed.account ?? null,
        },
        envelope: {
          sourceSchema: "stripe.webhook_event.v1",
          objectType: "event",
          operation: "upsert",
          observedAt: new Date().toISOString(),
          originalSource: "stripe",
          externalId: eventId,
          ...(eventId !== "unknown" ? { idempotencyKey: `stripe:event:${eventId}` } : {}),
        },
      },
    ];
  },

  syncObjectTypes: Object.keys(LIST_PATHS).map((objectType) => ({
    objectType,
    checkpointType: "cursor" as const,
  })),

  async fetchIncremental(ctx: FetchIncrementalContext): Promise<FetchIncrementalResult> {
    const apiKey = ctx.credentials["api_key"];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw brainError("source_credential_invalid", "Stripe connection has no api_key");
    }
    const { partition } = ctx;
    const target = LIST_PATHS[partition.objectType];
    if (target === undefined) {
      throw brainError(
        "raw_source_unsupported",
        `stripe adapter has no pull for object_type '${partition.objectType}'`,
      );
    }

    const checkpoint = (partition.committedCheckpoint ?? {
      watermark_created: null,
      page_after: null,
      pending_watermark: null,
    }) as StripeCheckpoint;

    // Connection identity, once per checkpoint lifetime.
    const accountId = checkpoint.stripe_account_id ?? (await stripeAccountId(apiKey));

    const page = await stripeListPage(apiKey, target.path, {
      ...(checkpoint.watermark_created !== null ? { createdGt: checkpoint.watermark_created } : {}),
      ...(checkpoint.page_after !== null ? { startingAfter: checkpoint.page_after } : {}),
    });

    const pendingWatermark = Math.max(checkpoint.pending_watermark ?? 0, page.maxCreated ?? 0);
    const walkDone = !page.hasMore || page.lastId === null;
    const nextCheckpoint: StripeCheckpoint = walkDone
      ? {
          stripe_account_id: accountId,
          watermark_created: pendingWatermark > 0 ? pendingWatermark : checkpoint.watermark_created,
          page_after: null,
          pending_watermark: null,
        }
      : {
          stripe_account_id: accountId,
          watermark_created: checkpoint.watermark_created,
          page_after: page.lastId,
          pending_watermark: pendingWatermark > 0 ? pendingWatermark : null,
        };

    const artifacts: FetchedArtifact[] =
      page.count === 0
        ? []
        : [
            {
              body: page.body,
              mimeType: "application/json",
              sourceRef: {
                provider: "stripe",
                pull: target.path,
                stripe_account_id: accountId,
              },
              envelope: {
                sourceSchema: target.schema,
                objectType: partition.objectType,
                operation: "upsert",
                observedAt: new Date().toISOString(),
                originalSource: "stripe",
                sourceId: partition.sourceId,
                ...(page.lastId !== null ? { sourceVersion: page.lastId } : {}),
                // Stable per page position: a retry of an uncommitted
                // checkpoint re-fetches the same (watermark, after) page and
                // dedups here even if Stripe's response bytes vary.
                idempotencyKey:
                  `${partition.sourceId}:${partition.objectType}:` +
                  `${checkpoint.watermark_created ?? "backfill"}:${checkpoint.page_after ?? "start"}`,
              },
            },
          ];

    return { artifacts, nextCheckpoint, hasMore: !walkDone };
  },
};
