/**
 * Merge accounting-aggregator source adapter (Phase 3 connector 3).
 *
 * One connector covers QuickBooks, Xero, NetSuite, Sage, and FreshBooks via
 * Merge's normalized accounting schema. Authenticated watermark pull
 * (ingestion method 2) across six per-object-type partitions (§10):
 * gl_account, journal_entry, invoice (covers bills: Merge invoices carry a
 * type of ACCOUNTS_PAYABLE or ACCOUNTS_RECEIVABLE), contact (vendors +
 * customers), payment, tax_rate.
 *
 *  - Backfill pages via the Merge `next` cursor until exhausted,
 *    accumulating the highest `modified_at` seen.
 *  - Delta runs filter `modified_after = watermark` and page the same way.
 *  - The watermark commits only when a walk completes; a crash mid-walk
 *    resumes from `page_cursor` and the envelope idempotency key (stable per
 *    page position) absorbs the replay.
 *
 * The linked account's underlying platform (e.g. "NetSuite") is fetched once
 * into the checkpoint and carried on artifact sourceRef, so the original
 * source stays visible through the aggregator.
 */

import { brainError } from "@brain/shared";
import { mergeIntegrationName, mergeListPage, type MergeCredentials } from "./merge-client.js";
import type {
  FetchedArtifact,
  FetchIncrementalContext,
  FetchIncrementalResult,
  SourceAdapter,
} from "./types.js";

interface MergeCheckpoint {
  /** Underlying platform name (NetSuite, QuickBooks, ...), fetched once. */
  merge_integration?: string;
  /** Committed high-water mark (ISO 8601); null until the first walk completes. */
  watermark_modified: string | null;
  /** Mid-walk Merge `next` cursor; null between walks. */
  page_cursor: string | null;
  /** Highest modified_at seen during the current walk. */
  pending_watermark: string | null;
}

const LIST_PATHS: Readonly<Record<string, { path: string; schema: string }>> = {
  gl_account: { path: "/accounts", schema: "merge_accounting.gl_accounts.v1" },
  journal_entry: { path: "/journal-entries", schema: "merge_accounting.journal_entries.v1" },
  invoice: { path: "/invoices", schema: "merge_accounting.invoices.v1" },
  contact: { path: "/contacts", schema: "merge_accounting.contacts.v1" },
  payment: { path: "/payments", schema: "merge_accounting.payments.v1" },
  tax_rate: { path: "/tax-rates", schema: "merge_accounting.tax_rates.v1" },
};

export const MergeAccountingAdapter: SourceAdapter = {
  sourceType: "merge_accounting",
  // Aggregator pull is authenticated by platform key + linked-account token;
  // artifacts of this type must never be mintable via generic /raw/ingest.
  providerAuthenticatedOnly: true,

  syncObjectTypes: Object.keys(LIST_PATHS).map((objectType) => ({
    objectType,
    checkpointType: "watermark" as const,
  })),

  async fetchIncremental(ctx: FetchIncrementalContext): Promise<FetchIncrementalResult> {
    const apiKey = ctx.credentials["api_key"];
    const accountToken = ctx.credentials["account_token"];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw brainError("source_credential_invalid", "Merge connection has no api_key");
    }
    if (typeof accountToken !== "string" || accountToken.length === 0) {
      throw brainError("source_credential_invalid", "Merge connection has no account_token");
    }
    const creds: MergeCredentials = { apiKey, accountToken };

    const { partition } = ctx;
    const target = LIST_PATHS[partition.objectType];
    if (target === undefined) {
      throw brainError(
        "raw_source_unsupported",
        `merge_accounting adapter has no pull for object_type '${partition.objectType}'`,
      );
    }

    const checkpoint = (partition.committedCheckpoint ?? {
      watermark_modified: null,
      page_cursor: null,
      pending_watermark: null,
    }) as MergeCheckpoint;

    // Original-source visibility, once per checkpoint lifetime.
    const integration = checkpoint.merge_integration ?? (await mergeIntegrationName(creds));

    const page = await mergeListPage(creds, target.path, {
      ...(checkpoint.watermark_modified !== null
        ? { modifiedAfter: checkpoint.watermark_modified }
        : {}),
      ...(checkpoint.page_cursor !== null ? { cursor: checkpoint.page_cursor } : {}),
    });

    const pendingWatermark =
      page.maxModifiedAt !== null &&
      (checkpoint.pending_watermark === null || page.maxModifiedAt > checkpoint.pending_watermark)
        ? page.maxModifiedAt
        : checkpoint.pending_watermark;
    const walkDone = page.nextCursor === null;
    const nextCheckpoint: MergeCheckpoint = walkDone
      ? {
          merge_integration: integration,
          watermark_modified: pendingWatermark ?? checkpoint.watermark_modified,
          page_cursor: null,
          pending_watermark: null,
        }
      : {
          merge_integration: integration,
          watermark_modified: checkpoint.watermark_modified,
          page_cursor: page.nextCursor,
          pending_watermark: pendingWatermark,
        };

    const artifacts: FetchedArtifact[] =
      page.count === 0
        ? []
        : [
            {
              body: page.body,
              mimeType: "application/json",
              sourceRef: {
                provider: "merge",
                pull: target.path,
                merge_integration: integration,
              },
              envelope: {
                sourceSchema: target.schema,
                objectType: partition.objectType,
                operation: "upsert",
                observedAt: new Date().toISOString(),
                // The aggregator transmits; the underlying platform asserted.
                originalSource: integration.toLowerCase(),
                intermediaries: ["merge"],
                sourceId: partition.sourceId,
                idempotencyKey:
                  `${partition.sourceId}:${partition.objectType}:` +
                  `${checkpoint.watermark_modified ?? "backfill"}:${checkpoint.page_cursor ?? "start"}`,
              },
            },
          ];

    return { artifacts, nextCheckpoint, hasMore: !walkDone };
  },
};
