/**
 * Plaid source adapter.
 *
 * Two modalities (ingestion methods 1 + 2):
 *  - handleWebhook: accepts Plaid webhooks (already signature-verified by the
 *    webhook route) and produces artifacts whose body is the JSON payload +
 *    source_ref capturing the webhook identifier for idempotency. Webhooks
 *    schedule a synchronization; they are not the authoritative record.
 *  - fetchIncremental: the authenticated pull path. Per-object-type
 *    partitions (§10): `transaction` via the transactions/sync cursor
 *    (backfill on first sync, deltas after), `balance` via snapshot.
 *
 * Pull artifacts are the verbatim Plaid response bytes wrapped in the §9
 * envelope. Plaid varies `request_id` per response, so content-hash dedup
 * alone would re-land a retried page; the envelope idempotencyKey is keyed
 * by the cursor BEFORE the page, which is stable across retries of an
 * uncommitted checkpoint.
 */

import { brainError } from "@brain/shared";
import { plaidClientConfig, transactionsSyncPage, balanceSnapshot } from "./plaid-client.js";
import type {
  FetchedArtifact,
  FetchIncrementalContext,
  FetchIncrementalResult,
  SourceAdapter,
} from "./types.js";

interface PlaidWebhookEnvelope {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  webhook_id?: string;
  // Plaid varies the remaining shape by webhook_code; we keep the payload
  // as-is for the Wiki extraction pipeline in stage-3.
}

export const PlaidAdapter: SourceAdapter = {
  sourceType: "plaid",
  // High-trust provider: only the HMAC-verified webhook may create plaid
  // artifacts, never the generic caller-supplied /raw/ingest route.
  providerAuthenticatedOnly: true,
  async handleWebhook(_tenantId, rawBody): Promise<FetchedArtifact[]> {
    let parsed: PlaidWebhookEnvelope;
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as PlaidWebhookEnvelope;
    } catch {
      throw brainError("request_body_invalid", "Plaid webhook body was not JSON");
    }

    const webhookId = parsed.webhook_id ?? parsed.item_id ?? "unknown";
    const webhookType = parsed.webhook_type ?? "unknown";
    const webhookCode = parsed.webhook_code ?? "unknown";

    return [
      {
        body: rawBody,
        mimeType: "application/json",
        sourceRef: {
          provider: "plaid",
          webhook_id: webhookId,
          webhook_type: webhookType,
          webhook_code: webhookCode,
          item_id: parsed.item_id ?? null,
        },
      },
    ];
  },

  syncObjectTypes: [
    { objectType: "transaction", checkpointType: "cursor" },
    { objectType: "balance", checkpointType: "snapshot" },
  ],

  async fetchIncremental(ctx: FetchIncrementalContext): Promise<FetchIncrementalResult> {
    const cfg = plaidClientConfig();
    if (cfg === null) {
      throw brainError(
        "raw_source_unsupported",
        "Plaid pull path is not configured (PLAID_CLIENT_ID / PLAID_SECRET unset)",
        { statusOverride: 503 },
      );
    }
    const accessToken = ctx.credentials["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw brainError("source_credential_invalid", "Plaid connection has no access_token");
    }

    const { partition } = ctx;
    if (partition.objectType === "transaction") {
      const checkpoint = partition.committedCheckpoint as { cursor?: string } | null;
      const cursor = typeof checkpoint?.cursor === "string" ? checkpoint.cursor : null;
      const page = await transactionsSyncPage(cfg, accessToken, cursor);
      return {
        artifacts: [
          {
            body: page.body,
            mimeType: "application/json",
            sourceRef: { provider: "plaid", pull: "transactions_sync" },
            envelope: {
              sourceSchema: "plaid.transactions_sync.v1",
              objectType: "transaction",
              operation: "upsert",
              observedAt: new Date().toISOString(),
              originalSource: "plaid",
              sourceId: partition.sourceId,
              sourceVersion: page.nextCursor,
              // Keyed by the cursor BEFORE this page: a retry of an
              // uncommitted checkpoint re-fetches and dedups here even though
              // Plaid's response bytes differ (request_id churn).
              idempotencyKey: `${partition.sourceId}:transaction:${cursor ?? "backfill_start"}`,
            },
          },
        ],
        nextCheckpoint: { cursor: page.nextCursor },
        hasMore: page.hasMore,
      };
    }

    if (partition.objectType === "balance") {
      const snapshot = await balanceSnapshot(cfg, accessToken);
      const snapshotAt = new Date().toISOString();
      return {
        artifacts: [
          {
            body: snapshot.body,
            mimeType: "application/json",
            sourceRef: { provider: "plaid", pull: "balance_get" },
            envelope: {
              sourceSchema: "plaid.balance.v1",
              objectType: "balance",
              operation: "snapshot",
              observedAt: snapshotAt,
              originalSource: "plaid",
              sourceId: partition.sourceId,
              idempotencyKey: `${partition.sourceId}:balance:${snapshotAt}`,
            },
          },
        ],
        nextCheckpoint: { snapshot_at: snapshotAt },
        hasMore: false,
      };
    }

    throw brainError(
      "raw_source_unsupported",
      `plaid adapter has no pull for object_type '${partition.objectType}'`,
    );
  },
};
