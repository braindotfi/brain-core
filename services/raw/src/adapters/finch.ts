/**
 * Finch payroll-aggregator source adapter (Phase 3 connector 4).
 *
 * One connector covers Gusto, Rippling, ADP, and Deel. This is the
 * sensitive-scoped-data connector: directory and pay-statement payloads are
 * PII-bearing, so they land ONLY as encrypted raw bytes; the extractor
 * minimizes what reaches the Ledger (see ledger/extractors/finch.ts) and the
 * client never calls the SSN-bearing /employer/individual endpoint at all.
 *
 * Three partitions (§10):
 *  - company:    daily snapshot of /employer/company
 *  - individual: daily snapshot walk of /employer/directory (offset-paged)
 *  - pay_run:    daily date-window watermark over /employer/payment; each
 *                batch also fetches the window's pay statements so a pay run
 *                and its detail land together
 *
 * Daily cadence: payroll moves at day granularity; the snapshot/watermark
 * day-gate keeps a 15-minute sync interval from minting 96 identical
 * artifacts a day. A run created later the same day is picked up on the
 * next day's window (the window re-pulls from the previous watermark DAY,
 * inclusive, so nothing is skipped).
 */

import { brainError } from "@brain/shared";
import {
  finchCompany,
  finchDirectoryPage,
  finchPayments,
  finchPayStatements,
} from "./finch-client.js";
import type {
  FetchedArtifact,
  FetchIncrementalContext,
  FetchIncrementalResult,
  SourceAdapter,
} from "./types.js";

interface FinchCheckpoint {
  /** Day (YYYY-MM-DD) the last successful snapshot/window completed. */
  snapshot_day: string | null;
  /** Mid-walk directory offset; null between walks. */
  directory_offset: number | null;
  /** Pay-run watermark day (YYYY-MM-DD); windows re-pull from here inclusive. */
  watermark_day: string | null;
}

/** Backfill horizon when a connection has no watermark yet. */
const DEFAULT_BACKFILL_START = "2024-01-01";
const DIRECTORY_PAGE_LIMIT = 250;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyResult(checkpoint: FinchCheckpoint): FetchIncrementalResult {
  return { artifacts: [], nextCheckpoint: checkpoint, hasMore: false };
}

export const FinchAdapter: SourceAdapter = {
  sourceType: "finch",
  // Sensitive scoped data: finch artifacts may only arrive through the
  // authenticated pull, never via generic caller-supplied /raw/ingest.
  providerAuthenticatedOnly: true,

  syncObjectTypes: [
    { objectType: "company", checkpointType: "snapshot" },
    { objectType: "individual", checkpointType: "snapshot" },
    { objectType: "pay_run", checkpointType: "watermark" },
  ],

  async fetchIncremental(ctx: FetchIncrementalContext): Promise<FetchIncrementalResult> {
    const accessToken = ctx.credentials["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw brainError("source_credential_invalid", "Finch connection has no access_token");
    }
    const { partition } = ctx;
    const checkpoint = (partition.committedCheckpoint ?? {
      snapshot_day: null,
      directory_offset: null,
      watermark_day: null,
    }) as FinchCheckpoint;
    const day = today();
    const observedAt = new Date().toISOString();

    const base = (schema: string, body: Buffer, idemSuffix: string): FetchedArtifact => ({
      body,
      mimeType: "application/json",
      sourceRef: { provider: "finch", object_type: partition.objectType },
      envelope: {
        sourceSchema: schema,
        objectType: partition.objectType,
        operation: partition.checkpointType === "snapshot" ? "snapshot" : "upsert",
        observedAt,
        originalSource: "finch",
        sourceId: partition.sourceId,
        idempotencyKey: `${partition.sourceId}:${partition.objectType}:${idemSuffix}`,
      },
    });

    if (partition.objectType === "company") {
      if (checkpoint.snapshot_day === day) return emptyResult(checkpoint);
      const snapshot = await finchCompany(accessToken);
      return {
        artifacts: [base("finch.company.v1", snapshot.body, day)],
        nextCheckpoint: { ...checkpoint, snapshot_day: day },
        hasMore: false,
      };
    }

    if (partition.objectType === "individual") {
      const midWalk = checkpoint.directory_offset !== null;
      if (!midWalk && checkpoint.snapshot_day === day) return emptyResult(checkpoint);
      const offset = checkpoint.directory_offset ?? 0;
      const page = await finchDirectoryPage(accessToken, offset, DIRECTORY_PAGE_LIMIT);
      const artifacts =
        page.count === 0 ? [] : [base("finch.directory.v1", page.body, `${day}:${offset}`)];
      return {
        artifacts,
        nextCheckpoint: page.hasMore
          ? { ...checkpoint, directory_offset: offset + page.count }
          : { ...checkpoint, directory_offset: null, snapshot_day: day },
        hasMore: page.hasMore,
      };
    }

    if (partition.objectType === "pay_run") {
      if (checkpoint.watermark_day === day) return emptyResult(checkpoint);
      // Re-pull from the watermark day INCLUSIVE: a run created later on the
      // watermark day is caught by the next window; idempotency keys +
      // content hashing absorb the overlap.
      const startDate = checkpoint.watermark_day ?? DEFAULT_BACKFILL_START;
      const window = await finchPayments(accessToken, startDate, day);
      const artifacts: FetchedArtifact[] = [];
      if (window.paymentIds.length > 0) {
        artifacts.push(base("finch.payments.v1", window.body, `${startDate}:${day}`));
        const statements = await finchPayStatements(accessToken, window.paymentIds);
        artifacts.push(
          base("finch.pay_statements.v1", statements.body, `stmts:${startDate}:${day}`),
        );
      }
      return {
        artifacts,
        nextCheckpoint: { ...checkpoint, watermark_day: day },
        hasMore: false,
      };
    }

    throw brainError(
      "raw_source_unsupported",
      `finch adapter has no pull for object_type '${partition.objectType}'`,
    );
  },
};
